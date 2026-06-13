"""Backend-native execution for SuperLeaf MCP tools.

This module is intentionally transport-agnostic. The Streamable HTTP/SSE MCP
route can authenticate a token, build a ``SuperleafMcpToolContext``, and call
these functions without going through the browser bridge.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from difflib import SequenceMatcher
from pathlib import PurePosixPath
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Annotation, Doc, FileBlob, Folder, McpToken, Project, User
from . import annotation_service
from .event_bus import bus
from .native_agent_tool_kernel import _extract_outline
from .project_fs_service import ProjectFsService
from .project_member_service import ProjectMemberService
from .project_service import ProjectService


_READ_LIMIT = 20_000
_GREP_DEFAULT_LIMIT = 50
_GREP_HARD_LIMIT = 200
_GREP_PREVIEW_CHARS = 240
_GREP_MAX_PATTERN_LENGTH = 500
_GREP_MAX_DOC_CHARS = 500_000
_LIST_LIMIT = 500
_PROJECT_CREATE_CONTENT_LIMIT = 512 * 1024
_PROJECT_CREATE_MAX_PATH_CHARS = 512
_PROJECT_CREATE_MAX_SEGMENT_CHARS = 256
_PROJECT_CREATE_DOC_EXTS: dict[str, str] = {
    "tex": "tex",
    "latex": "tex",
    "ltx": "tex",
    "bib": "tex",
    "sty": "tex",
    "cls": "tex",
    "bst": "tex",
    "md": "md",
    "markdown": "md",
    "txt": "txt",
}


@dataclass(frozen=True, slots=True)
class SuperleafMcpToolContext:
    user: User
    token: McpToken
    active_project_id: str = ""

    @property
    def can_write(self) -> bool:
        return (self.token.scope or "read").strip().lower() == "write"


def call_superleaf_mcp_tool(
    db: Session,
    ctx: SuperleafMcpToolContext,
    name: str,
    arguments: dict[str, Any] | None = None,
) -> tuple[str, SuperleafMcpToolContext]:
    """Execute a SuperLeaf MCP tool and return a JSON text result plus context."""
    args = arguments or {}
    tool_name = (name or "").strip()

    if tool_name == "superleaf_list_projects":
        return _json_text({"projects": _list_projects(db, ctx, args)}), ctx
    if tool_name == "superleaf_select_project":
        project_id = _required_str(args, "project_id")
        project = _require_project_access(db, project_id, ctx.user.id)
        next_ctx = replace(ctx, active_project_id=project.id)
        return _json_text({"project": _project_out(db, project, ctx.user.id)}), next_ctx
    if tool_name == "project_list_docs":
        project_id = _resolve_project_id(ctx, args)
        _require_project_access(db, project_id, ctx.user.id)
        return _json_text({"docs": _list_docs(db, project_id)}), ctx
    if tool_name == "project_read_doc":
        return _json_text(_read_doc(db, ctx, args)), ctx
    if tool_name == "project_grep":
        return _json_text(_grep(db, ctx, args)), ctx
    if tool_name == "project_outline":
        return _json_text(_outline(db, ctx, args)), ctx
    if tool_name in {"project_write_text_file", "project_create_text_file"}:
        return _json_text(_write_text_file(db, ctx, args)), ctx
    if tool_name == "propose_doc_edit":
        return _json_text(_propose_doc_edit(db, ctx, args)), ctx
    if tool_name == "create_suggestion":
        return _json_text(_create_suggestion(db, ctx, args)), ctx

    raise HTTPException(400, f"Unknown SuperLeaf MCP tool: {tool_name}")


def _list_projects(
    db: Session,
    ctx: SuperleafMcpToolContext,
    args: dict[str, Any],
) -> list[dict[str, Any]]:
    type_filter = str(args.get("project_type") or "all").strip().lower()
    member_svc = ProjectMemberService(db)
    pairs: list[tuple[Project, str]] = [
        (project, "owner") for project in ProjectService(db).list(user_id=ctx.user.id)
    ]
    for project, member in member_svc.list_shared_projects(ctx.user.id):
        pairs.append((project, member.role))

    projects: list[dict[str, Any]] = []
    for project, role in pairs:
        project_type = project.project_type or "paper"
        if type_filter not in {"", "all"} and project_type != type_filter:
            continue
        projects.append(_project_out(db, project, ctx.user.id, role=role))
    return projects


def _project_out(
    db: Session,
    project: Project,
    user_id: str,
    *,
    role: str | None = None,
) -> dict[str, Any]:
    return {
        "id": project.id,
        "name": project.name,
        "project_type": project.project_type or "paper",
        "my_role": role or ProjectMemberService(db).get_role(project.id, user_id) or "",
        "main_doc_id": project.main_doc_id or "",
        "updated_at": project.updated_at,
    }


def _list_docs(db: Session, project_id: str) -> list[dict[str, Any]]:
    rows = (
        db.query(Doc.id, Doc.name, Doc.format, Doc.folder_id, Doc.updated_at)
        .filter(Doc.project_id == project_id)
        .order_by(Doc.name.asc())
        .limit(_LIST_LIMIT)
        .all()
    )
    return [
        {
            "id": row.id,
            "name": row.name,
            "format": row.format,
            "folder_id": row.folder_id or "",
            "updated_at": row.updated_at,
        }
        for row in rows
    ]


def _read_doc(
    db: Session,
    ctx: SuperleafMcpToolContext,
    args: dict[str, Any],
) -> dict[str, Any]:
    project_id = _resolve_project_id(ctx, args)
    _require_project_access(db, project_id, ctx.user.id)
    doc_id = _required_str(args, "doc_id")
    doc = _require_doc_in_project(db, project_id, doc_id)

    content = doc.content or ""
    total = len(content)
    start = max(0, min(_int_arg(args, "range_start", default=0), total))
    raw_end = args.get("range_end")
    end = total if raw_end is None else max(start, min(_int_arg(args, "range_end"), total))
    if end - start > _READ_LIMIT:
        end = start + _READ_LIMIT

    return {
        "doc_id": doc.id,
        "name": doc.name,
        "format": doc.format,
        "total_length": total,
        "range_start": start,
        "range_end": end,
        "content": content[start:end],
        "truncated": end < total or start > 0,
    }


def _grep(
    db: Session,
    ctx: SuperleafMcpToolContext,
    args: dict[str, Any],
) -> dict[str, Any]:
    project_id = _resolve_project_id(ctx, args)
    _require_project_access(db, project_id, ctx.user.id)
    pattern = _required_str(args, "pattern")

    if len(pattern) > _GREP_MAX_PATTERN_LENGTH:
        raise HTTPException(400, f"regex pattern too long (max {_GREP_MAX_PATTERN_LENGTH} chars)")
    if _is_dangerous_regex(pattern):
        raise HTTPException(400, "regex pattern rejected: potential catastrophic backtracking")

    try:
        regex = re.compile(pattern, re.MULTILINE)
    except re.error as exc:
        raise HTTPException(400, f"invalid regex: {exc}") from exc

    max_results = max(1, min(_int_arg(args, "max_results", default=_GREP_DEFAULT_LIMIT), _GREP_HARD_LIMIT))
    format_filter = str(args.get("format") or "").strip().lower()
    query = db.query(Doc.id, Doc.name, Doc.format, Doc.content).filter(Doc.project_id == project_id)
    if format_filter:
        query = query.filter(Doc.format == format_filter)

    hits: list[dict[str, Any]] = []
    for row in query.all():
        content = row.content or ""
        if len(content) > _GREP_MAX_DOC_CHARS:
            continue
        for match in regex.finditer(content):
            line_start = content.rfind("\n", 0, match.start()) + 1
            line_end = content.find("\n", match.end())
            line_end = len(content) if line_end == -1 else line_end
            line_no = content.count("\n", 0, match.start()) + 1
            preview = content[line_start:line_end]
            if len(preview) > _GREP_PREVIEW_CHARS:
                cut_at = max(0, match.start() - line_start - 60)
                preview = preview[cut_at : cut_at + _GREP_PREVIEW_CHARS]
            hits.append(
                {
                    "doc_id": row.id,
                    "doc_name": row.name,
                    "format": row.format,
                    "offset": match.start(),
                    "line": line_no,
                    "preview": preview,
                }
            )
            if len(hits) >= max_results:
                break
        if len(hits) >= max_results:
            break
    return {"hits": hits, "truncated": len(hits) >= max_results}


def _outline(
    db: Session,
    ctx: SuperleafMcpToolContext,
    args: dict[str, Any],
) -> dict[str, Any]:
    project_id = _resolve_project_id(ctx, args)
    _require_project_access(db, project_id, ctx.user.id)
    doc_id = _required_str(args, "doc_id")
    doc = _require_doc_in_project(db, project_id, doc_id)
    fmt = (doc.format or "").lower()
    sections = _extract_outline(doc.content or "", fmt)
    return {
        "doc_id": doc.id,
        "name": doc.name,
        "format": fmt,
        "sections": [
            {
                "level": int(section.get("level", 3)),
                "title": str(section.get("title", "")),
                "offset": int(section.get("offset", 0)),
            }
            for section in sections
        ],
    }


def _write_text_file(
    db: Session,
    ctx: SuperleafMcpToolContext,
    args: dict[str, Any],
) -> dict[str, Any]:
    project_id, project = _require_project_write_access(db, ctx, args)
    try:
        path_parts = _normalize_project_create_path(_required_str(args, "path"))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    content = args.get("content")
    if not isinstance(content, str):
        raise HTTPException(400, "content must be a string")
    content_bytes = len(content.encode("utf-8"))
    if content_bytes > _PROJECT_CREATE_CONTENT_LIMIT:
        raise HTTPException(400, f"content exceeds {_PROJECT_CREATE_CONTENT_LIMIT} bytes")

    name = path_parts[-1]
    try:
        doc_format = _project_doc_format_for_name(name, args.get("format"))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    svc = ProjectFsService(db, project)
    parent_folder_id: str | None = None
    for folder_name in path_parts[:-1]:
        conflict = _project_sibling_kind(db, project_id, parent_folder_id, folder_name)
        if conflict in {"doc", "file"}:
            raise HTTPException(
                409,
                f"cannot create folder '{folder_name}' because a {conflict} with that name already exists",
            )
        folder = _project_find_folder(db, project_id, parent_folder_id, folder_name)
        if folder is None:
            try:
                folder = svc.create_folder(parent_folder_id=parent_folder_id, name=folder_name)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
        parent_folder_id = folder.id

    existing = _project_sibling_kind(db, project_id, parent_folder_id, name)
    if existing is not None:
        raise HTTPException(
            409,
            f"cannot create '{name}' because a {existing} with that name already exists",
        )
    try:
        doc = svc.create_doc(
            folder_id=parent_folder_id,
            name=name,
            format=doc_format,
            content=content,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    path = "/".join(path_parts)
    payload = {
        "action": "doc.created",
        "doc_id": doc.id,
        "folder_id": doc.folder_id,
        "name": doc.name,
        "format": doc.format,
        "path": path,
        "doc": _tree_doc_payload(doc),
    }
    bus.publish(project.id, "project.tree.changed", payload, origin_client_id="")
    return {
        "status": "created",
        "doc_id": doc.id,
        "path": path,
        "name": doc.name,
        "format": doc.format,
        "size_bytes": content_bytes,
    }


def _propose_doc_edit(
    db: Session,
    ctx: SuperleafMcpToolContext,
    args: dict[str, Any],
) -> dict[str, Any]:
    project_id, project = _require_project_write_access(db, ctx, args)
    doc = _require_doc_in_project(db, project_id, _required_str(args, "doc_id"))
    range_start = _int_arg(args, "range_start")
    range_end = _int_arg(args, "range_end")
    new_text = args.get("new_text")
    if not isinstance(new_text, str):
        raise HTTPException(400, "new_text must be a string")
    reason = str(args.get("reason") or "").strip()

    start, end, original_text = _resolve_edit_range(
        doc.content or "",
        args.get("original_text"),
        range_start,
        range_end,
    )
    row = _create_annotation_row(
        db,
        project=project,
        user_id=ctx.user.id,
        doc=doc,
        kind="suggestion",
        range_start=start,
        range_end=end,
        target_text=original_text,
        content=reason or "MCP edit proposal",
        original=original_text,
        proposed=new_text,
        reason=reason,
    )
    return {
        "status": "proposed",
        "proposal_id": row.id,
        "project_id": project_id,
        "doc_id": doc.id,
        "range_start": start,
        "range_end": end,
    }


def _create_suggestion(
    db: Session,
    ctx: SuperleafMcpToolContext,
    args: dict[str, Any],
) -> dict[str, Any]:
    project_id, project = _require_project_write_access(db, ctx, args)
    doc = _require_doc_in_project(db, project_id, _required_str(args, "doc_id"))
    original_text_arg = _required_str(args, "original_text")
    content = _required_str(args, "content")
    proposed_text = str(args.get("proposed_text") or "")
    reason = str(args.get("reason") or "").strip()
    range_start = _int_arg(args, "range_start", default=0)
    range_end = _int_arg(args, "range_end", default=0)

    start, end, original_text = _resolve_edit_range(
        doc.content or "",
        original_text_arg,
        range_start,
        range_end,
    )
    row = _create_annotation_row(
        db,
        project=project,
        user_id=ctx.user.id,
        doc=doc,
        kind="suggestion",
        range_start=start,
        range_end=end,
        target_text=original_text,
        content=content,
        original=original_text,
        proposed=proposed_text,
        reason=reason,
    )
    return {
        "status": "created",
        "suggestion_id": row.id,
        "project_id": project_id,
        "doc_id": doc.id,
        "range_start": start,
        "range_end": end,
    }


def _create_annotation_row(
    db: Session,
    *,
    project: Project,
    user_id: str,
    doc: Doc,
    kind: str,
    range_start: int,
    range_end: int,
    target_text: str,
    content: str,
    original: str,
    proposed: str,
    reason: str,
) -> Annotation:
    now = _utcnow_naive()
    row = Annotation(
        id=uuid.uuid4().hex,
        doc_id=doc.id,
        project_id=project.id,
        user_id=user_id,
        is_global=False,
        kind=kind,
        status="pending",
        range_from=range_start,
        range_to=range_end,
        target_text=target_text,
        content=content,
        severity="medium",
        workflow_id="",
        agent_name="SuperLeaf MCP",
        conversation_id="",
        original=original,
        proposed=proposed,
        reason=reason,
        risk_type="",
        mitigation="",
        thread=[
            {
                "id": uuid.uuid4().hex,
                "role": "agent",
                "content": content,
                "agent_name": "SuperLeaf MCP",
                "created_at": now.isoformat(),
            }
        ],
        attached_files=[],
        created_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    bus.publish(
        project.id,
        "annotation.created",
        {"annotation": annotation_service.to_dict(row)},
        origin_client_id="",
    )
    return row


def _require_project_access(db: Session, project_id: str, user_id: str) -> Project:
    project = db.get(Project, project_id)
    if project is None or not ProjectMemberService(db).has_access(project_id, user_id):
        raise HTTPException(404, "Project not found")
    return project


def _require_project_write_access(
    db: Session,
    ctx: SuperleafMcpToolContext,
    args: dict[str, Any],
) -> tuple[str, Project]:
    if not ctx.can_write:
        raise HTTPException(403, "This MCP token is read-only (scope=read)")
    project_id = _resolve_project_id(ctx, args)
    project = _require_project_access(db, project_id, ctx.user.id)
    if not ProjectMemberService(db).can_write(project_id, ctx.user.id):
        raise HTTPException(403, "Project write access required")
    return project_id, project


def _require_doc_in_project(db: Session, project_id: str, doc_id: str) -> Doc:
    doc = db.get(Doc, doc_id)
    if doc is None or doc.project_id != project_id:
        raise HTTPException(404, "doc not found in this project")
    return doc


def _resolve_project_id(ctx: SuperleafMcpToolContext, args: dict[str, Any]) -> str:
    project_id = str(args.get("project_id") or ctx.active_project_id or "").strip()
    if not project_id:
        raise HTTPException(400, "project_id is required; call superleaf_select_project first")
    return project_id


def _required_str(args: dict[str, Any], key: str) -> str:
    value = str(args.get(key) or "").strip()
    if not value:
        raise HTTPException(400, f"{key} is required")
    return value


def _int_arg(args: dict[str, Any], key: str, *, default: int | None = None) -> int:
    if key not in args or args[key] is None:
        if default is None:
            raise HTTPException(400, f"{key} is required")
        return default
    try:
        value = int(args[key])
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, f"{key} must be an integer") from exc
    if value < 0:
        raise HTTPException(400, f"{key} must be greater than or equal to 0")
    return value


def _is_dangerous_regex(pattern: str) -> bool:
    danger_patterns = [
        r"\([^)]*[+*?][^)]*\)[+*?]",
        r"\[[^\]]*[+*?][^\]]*\][+*?]",
    ]
    return any(re.search(danger, pattern) for danger in danger_patterns)


def _normalize_project_create_path(raw_path: str) -> list[str]:
    path = raw_path.strip().replace("\\", "/")
    if not path:
        raise ValueError("path is required")
    if len(path) > _PROJECT_CREATE_MAX_PATH_CHARS:
        raise ValueError(f"path exceeds {_PROJECT_CREATE_MAX_PATH_CHARS} characters")
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        raise ValueError("path must be relative to the current project")
    if path.endswith("/"):
        raise ValueError("path must include a filename")
    raw_parts = path.split("/")
    if any(part == "" for part in raw_parts):
        raise ValueError("path must not contain empty segments")
    parts: list[str] = []
    for part in raw_parts:
        clean = part.strip()
        if clean != part:
            raise ValueError("path segments must not have leading or trailing spaces")
        if clean in {".", ".."} or clean.casefold() == ".git":
            raise ValueError("path contains a forbidden segment")
        if "\x00" in clean:
            raise ValueError("path contains an invalid character")
        if len(clean) > _PROJECT_CREATE_MAX_SEGMENT_CHARS:
            raise ValueError(f"path segment exceeds {_PROJECT_CREATE_MAX_SEGMENT_CHARS} characters")
        PurePosixPath(clean)
        parts.append(clean)
    if not parts:
        raise ValueError("path must include a filename")
    return parts


def _project_doc_format_for_name(name: str, requested: Any) -> str:
    raw = str(requested or "").strip().lower()
    if raw:
        if raw not in {"tex", "md", "txt"}:
            raise ValueError("format must be one of tex, md, or txt")
        return raw
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return _PROJECT_CREATE_DOC_EXTS.get(ext, "txt")


def _project_find_folder(
    db: Session,
    project_id: str,
    parent_folder_id: str | None,
    name: str,
) -> Folder | None:
    return (
        db.query(Folder)
        .filter(
            Folder.project_id == project_id,
            Folder.parent_folder_id == parent_folder_id,
            Folder.name == name,
        )
        .first()
    )


def _project_sibling_kind(
    db: Session,
    project_id: str,
    folder_id: str | None,
    name: str,
) -> str | None:
    if _project_find_folder(db, project_id, folder_id, name) is not None:
        return "folder"
    doc = (
        db.query(Doc.id)
        .filter(Doc.project_id == project_id, Doc.folder_id == folder_id, Doc.name == name)
        .first()
    )
    if doc is not None:
        return "doc"
    file_blob = (
        db.query(FileBlob.id)
        .filter(
            FileBlob.project_id == project_id,
            FileBlob.folder_id == folder_id,
            FileBlob.name == name,
        )
        .first()
    )
    return "file" if file_blob is not None else None


def _tree_doc_payload(doc: Doc) -> dict[str, object]:
    return {
        "id": doc.id,
        "name": doc.name,
        "format": doc.format,
        "size_bytes": len((doc.content or "").encode("utf-8")),
        "updated_at": doc.updated_at.isoformat() if doc.updated_at else "",
    }


def _resolve_edit_range(
    content: str,
    original_text_arg: Any,
    range_start: int,
    range_end: int,
) -> tuple[int, int, str]:
    total = len(content)
    if isinstance(original_text_arg, str) and original_text_arg.strip():
        start, end, _anchor_text, err = _resolve_text_range(
            content,
            original_text_arg,
            range_start,
            range_end,
        )
        if err:
            raise HTTPException(400, err.removeprefix("ERROR: ").strip())
        return start, end, content[start:end]
    start = max(0, min(range_start, total))
    end = max(start, min(range_end, total))
    return start, end, content[start:end]


def _resolve_text_range(
    content: str,
    original_text: str,
    range_start: int,
    range_end: int,
) -> tuple[int, int, str | None, str | None]:
    anchor_text: str | None = original_text
    occurrences: list[int] = []
    pos = 0
    while True:
        idx = content.find(original_text, pos)
        if idx == -1:
            break
        occurrences.append(idx)
        pos = idx + 1

    if len(occurrences) == 1:
        start = occurrences[0]
        return start, start + len(original_text), anchor_text, None
    if len(occurrences) > 1:
        hint = range_start if range_start > 0 else 0
        if hint > 0:
            closest = min(occurrences, key=lambda x: abs(x - hint))
            return closest, closest + len(original_text), anchor_text, None
        return 0, 0, None, (
            f"ERROR: original_text appears {len(occurrences)} times in the document. "
            "Pass range_start/range_end to disambiguate."
        )

    fuzzy_pos = _fuzzy_find(content, original_text, threshold=0.85)
    if fuzzy_pos is not None:
        return fuzzy_pos, fuzzy_pos + len(original_text), anchor_text, None
    if range_end > range_start:
        start = max(0, min(range_start, len(content)))
        end = max(start, min(range_end, len(content)))
        return start, end, content[start:end], None
    return 0, 0, None, (
        "ERROR: original_text not found in document. Re-read the current content and try again."
    )


def _fuzzy_find(content: str, anchor: str, threshold: float = 0.85) -> int | None:
    anchor_len = len(anchor)
    if anchor_len == 0 or len(content) < anchor_len:
        return None
    best_ratio = 0.0
    best_pos: int | None = None
    step = max(1, anchor_len // 8)
    for i in range(0, len(content) - anchor_len + 1, step):
        candidate = content[i : i + anchor_len]
        ratio = SequenceMatcher(None, candidate, anchor).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_pos = i
            if ratio >= 0.95:
                break
    if best_ratio >= threshold and best_pos is not None:
        return best_pos
    return None


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=_json_default)


def _json_default(value: Any) -> str:
    if isinstance(value, datetime | date):
        return value.isoformat()
    return str(value)


def _utcnow_naive() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)

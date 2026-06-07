"""Native Agent Tool Kernel adapters.

This module owns the tool schemas, grouping rules, and backend-local execution
adapters exposed to backend Native Agents.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..database import SessionLocal
from ..models import Doc, FileBlob, Folder, Project
from .agent_workspace_service import (
    AgentWorkspaceError,
    list_agent_workspace_files,
    read_agent_workspace_file,
)
from .event_bus import bus
from .project_fs_service import ProjectFsService
from .project_member_service import ProjectMemberService
from .superleaf_tool_registry import superleaf_openai_tools


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
_PROJECT_LIST_LIMIT = 200
_PROJECT_READ_LIMIT = 40_000
_PROJECT_GREP_DEFAULT_LIMIT = 30
_PROJECT_GREP_HARD_LIMIT = 100
_PROJECT_GREP_PREVIEW_CHARS = 240


BROWSER_SUPERLEAF_TOOL_NAMES = frozenset(
    {
        "project_list_docs",
        "project_read_doc",
        "project_grep",
        "project_outline",
        "project_write_text_file",
        "project_create_text_file",
        "propose_doc_edit",
        "create_suggestion",
    }
)

NATIVE_PROJECT_CONTEXT_TOOL_NAMES = frozenset(
    {
        "project_list_docs",
        "project_read_doc",
        "project_grep",
        "project_outline",
    }
)

NATIVE_DOCUMENT_ACTION_TOOL_NAMES = frozenset(
    {
        "propose_doc_edit",
        "create_suggestion",
    }
)

PROJECT_WRITE_TOOL_NAMES = frozenset(
    {
        "project_write_text_file",
        "project_create_text_file",
    }
)


NATIVE_DB_BACKED_TOOL_NAMES = frozenset(
    {
        *NATIVE_PROJECT_CONTEXT_TOOL_NAMES,
        *NATIVE_DOCUMENT_ACTION_TOOL_NAMES,
        *PROJECT_WRITE_TOOL_NAMES,
    }
)


@dataclass(slots=True)
class NativeAgentToolContext:
    project_id: str = ""
    user_id: str = ""
    active_document_id: str = ""
    active_range_start: int = 0
    active_range_end: int = 0
    workspace_root: str = ""
    skills: list[Any] | None = None

    def project_scope_ok(self) -> bool:
        return bool(self.project_id and self.user_id)


@dataclass(slots=True)
class NativeAgentToolResult:
    content: str
    failed: bool = False
    failed_function_name: str = ""
    tool_kind: str = "workspace"
    trace_payload: dict[str, Any] | None = None
    # Set when the tool wants the runner to surface a side-channel event
    # (e.g. propose_doc_edit emits an edit proposal card to the chat UI).
    side_event: dict[str, Any] | None = None


def native_agent_workspace_tools() -> list[dict[str, Any]]:
    """Tools available to a full backend Native Agent run."""
    return [
        *_agent_workspace_file_tools(),
        *native_agent_project_context_tools(),
        *_native_project_write_tools(),
        *superleaf_openai_tools(NATIVE_DOCUMENT_ACTION_TOOL_NAMES),
    ]


def native_agent_project_context_tools() -> list[dict[str, Any]]:
    """Read-only SuperLeaf project document tools for workflow group chat."""
    return superleaf_openai_tools(NATIVE_PROJECT_CONTEXT_TOOL_NAMES)


def native_agent_skill_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "use_skill",
                "description": (
                    "Load the full instructions for one available Skill. "
                    "Calling this tool means the Skill is activated for this run."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "skill_id": {
                            "type": "string",
                            "description": "The id or alias from the Available Skills list.",
                        },
                        "reason": {
                            "type": "string",
                            "description": "Brief reason this Skill is needed now.",
                        },
                    },
                    "required": ["skill_id"],
                },
            },
        }
    ]


def browser_superleaf_tools() -> list[dict[str, Any]]:
    """Small SuperLeaf tool subset exposed to browser-local agent transports."""
    return superleaf_openai_tools(BROWSER_SUPERLEAF_TOOL_NAMES)


def execute_native_agent_db_tool(
    name: str,
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult | None:
    """Execute DB-backed SuperLeaf tools owned by the Tool Kernel.

    Returns ``None`` for non-DB or unknown tools so callers can keep routing
    workspace, skill, and external MCP tools through their existing paths.
    """
    if name == "project_list_docs":
        return _tool_project_list_docs(args, context)
    if name == "project_read_doc":
        return _tool_project_read_doc(args, context)
    if name == "project_grep":
        return _tool_project_grep(args, context)
    if name == "project_outline":
        return _tool_project_outline(args, context)
    if name in PROJECT_WRITE_TOOL_NAMES:
        return _tool_project_write_text_file(args, context)
    if name == "propose_doc_edit":
        return _tool_propose_doc_edit(args, context)
    if name == "create_suggestion":
        return _tool_create_suggestion(args, context)
    return None


def execute_native_agent_local_tool(
    name: str,
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult | None:
    """Execute backend-local non-DB tools owned by the Tool Kernel.

    Returns ``None`` for tools outside this layer so the runner can continue
    routing DB-backed SuperLeaf tools and external MCP tools through their
    dedicated adapters.
    """
    if name == "list_agent_files":
        return _tool_list_agent_files(args, context)
    if name == "read_agent_file":
        return _tool_read_agent_file(args, context)
    if name == "use_skill":
        return _tool_use_skill(args, context)
    return None


def _agent_workspace_file_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "list_agent_files",
                "description": "List files and folders in this Agent's read-only .agents workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prefix": {
                            "type": "string",
                            "description": "Path under .agents, for example .agents or .agents/skills.",
                        }
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_agent_file",
                "description": "Read a safe text file from this Agent's read-only .agents workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": (
                                "File path under .agents, for example "
                                ".agents/skills/name/SKILL.md."
                            ),
                        }
                    },
                    "required": ["path"],
                },
            },
        },
    ]


def _tool_list_agent_files(
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult:
    if not context.workspace_root:
        return NativeAgentToolResult("ERROR: Agent workspace root not available", failed=True)
    prefix = str(args.get("prefix") or ".agents")
    try:
        files = list_agent_workspace_files(Path(context.workspace_root), prefix=prefix)
    except AgentWorkspaceError as exc:
        return NativeAgentToolResult(f"ERROR: {exc}", failed=True)
    return NativeAgentToolResult(
        json.dumps(
            [{"path": file.path, "type": file.type, "size": file.size} for file in files],
            ensure_ascii=False,
        )
    )


def _tool_read_agent_file(
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult:
    if not context.workspace_root:
        return NativeAgentToolResult("ERROR: Agent workspace root not available", failed=True)
    path = str(args.get("path") or "")
    try:
        content = read_agent_workspace_file(Path(context.workspace_root), path)
    except AgentWorkspaceError as exc:
        return NativeAgentToolResult(f"ERROR: {exc}", failed=True)
    return NativeAgentToolResult(content)


def _tool_use_skill(
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult:
    skill_id = str(args.get("skill_id") or "").strip()
    reason = str(args.get("reason") or "").strip()
    if not skill_id:
        return NativeAgentToolResult("ERROR: skill_id is required", failed=True, tool_kind="skill")
    skill = _skill_by_ref(context.skills or [], skill_id)
    if skill is None:
        available = ", ".join(str(getattr(s, "name", "")) for s in context.skills or [])
        return NativeAgentToolResult(
            f"ERROR: skill not found. Available: {available}",
            failed=True,
            tool_kind="skill",
        )
    if not context.workspace_root:
        return NativeAgentToolResult("ERROR: Agent workspace root not available", failed=True, tool_kind="skill")
    root = Path(context.workspace_root)
    skill_path = root / ".agents" / str(getattr(skill, "folder_path", ""))
    if skill_path.is_file() and skill_path.suffix == ".json":
        try:
            ref = json.loads(skill_path.read_text(encoding="utf-8"))
            target = ref.get("target_path", "")
            folder = Path(target) if target else skill_path.parent
        except (OSError, json.JSONDecodeError):
            return NativeAgentToolResult("ERROR: cannot resolve skill reference", failed=True, tool_kind="skill")
    else:
        folder = skill_path
    skill_md = folder / "SKILL.md"
    if not skill_md.is_file():
        return NativeAgentToolResult("ERROR: SKILL.md not found", failed=True, tool_kind="skill")
    try:
        content = skill_md.read_text(encoding="utf-8", errors="replace").strip()
    except OSError as exc:
        return NativeAgentToolResult(f"ERROR: {exc}", failed=True, tool_kind="skill")
    if not content:
        return NativeAgentToolResult("ERROR: SKILL.md is empty", failed=True, tool_kind="skill")
    tree = _skill_file_tree(folder)
    payload = _skill_activation_payload(skill, reason=reason)
    return NativeAgentToolResult(
        content + "\n\n---\n\nFiles in this Skill:\n" + tree,
        tool_kind="skill",
        trace_payload=payload,
    )


def _skill_by_ref(skills: list[Any], skill_id: str) -> Any | None:
    needle = _normalize_skill_ref(skill_id)
    for skill in skills:
        refs = [
            str(getattr(skill, "id", "")),
            str(getattr(skill, "name", "")),
            *list(getattr(skill, "aliases", []) or []),
        ]
        if any(_normalize_skill_ref(ref) == needle for ref in refs):
            return skill
    return None


def _skill_activation_payload(skill: Any, *, reason: str = "") -> dict[str, Any]:
    activation_payload = getattr(skill, "activation_payload", None)
    if callable(activation_payload):
        return activation_payload(reason=reason)
    return {
        "skill_id": str(getattr(skill, "id", "")),
        "skill_name": str(getattr(skill, "name", "")),
        "skill_version": getattr(skill, "version", 0),
        "skill_source": str(getattr(skill, "source", "")),
        "reason": reason.strip(),
    }


def _normalize_skill_ref(value: str) -> str:
    return str(value or "").strip().lower()


def _skill_file_tree(folder: Path) -> str:
    """Return a markdown-style file tree of a skill folder."""
    lines: list[str] = []
    forbidden = {".git", "node_modules", "__pycache__", ".venv"}
    for path in sorted(folder.rglob("*")):
        if any(part in forbidden for part in path.parts):
            continue
        rel = path.relative_to(folder).as_posix()
        if path.is_dir():
            lines.append(f"  {rel}/")
        else:
            size = path.stat().st_size
            lines.append(f"  {rel}  ({size}B)")
    return "\n".join(lines) if lines else "(empty)"


def _native_project_write_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "project_write_text_file",
                "description": (
                    "Create a new text document in the current project by relative path and "
                    "write its full content in the same database operation. "
                    "Use only when the user explicitly asks you to create a new project file "
                    "or reference file. Intermediate folders are created automatically. "
                    "The tool refuses to overwrite existing docs, files, or folders. "
                    "Supported document formats are tex, md, and txt; format is inferred "
                    "from the filename when possible and otherwise defaults to txt."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": (
                                "Relative project path, for example "
                                "references/paper-style.md or examples/rule.txt."
                            ),
                        },
                        "content": {
                            "type": "string",
                            "description": "Full UTF-8 text content for the new file.",
                        },
                        "format": {
                            "type": "string",
                            "enum": ["tex", "md", "txt"],
                            "description": (
                                "Optional stored document format. If omitted, inferred from "
                                "the filename extension when supported, otherwise txt."
                            ),
                        },
                    },
                    "required": ["path", "content"],
                },
            },
        },
    ]


def _tool_project_list_docs(
    _args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult:
    if not context.project_scope_ok():
        return NativeAgentToolResult("ERROR: project scope not available", failed=True)
    with SessionLocal() as db:
        rows = (
            db.query(Doc.id, Doc.name, Doc.format, Doc.folder_id, Doc.updated_at)
            .filter(
                Doc.project_id == context.project_id,
            )
            .order_by(Doc.name.asc())
            .limit(_PROJECT_LIST_LIMIT)
            .all()
        )
    out = [
        {
            "id": r.id,
            "name": r.name,
            "format": r.format,
            "folder_id": r.folder_id or "",
            "updated_at": r.updated_at.isoformat() if r.updated_at else "",
        }
        for r in rows
    ]
    return NativeAgentToolResult(json.dumps(out, ensure_ascii=False))


def _tool_project_read_doc(
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult:
    if not context.project_scope_ok():
        return NativeAgentToolResult("ERROR: project scope not available", failed=True)
    doc_id = _resolve_active_doc_id(args, context)
    if not doc_id:
        return NativeAgentToolResult("ERROR: doc_id is required and no active document is available", failed=True)
    try:
        range_start = int(args.get("range_start") or 0)
        range_end_raw = args.get("range_end")
        range_end = int(range_end_raw) if range_end_raw is not None else None
    except (TypeError, ValueError):
        return NativeAgentToolResult("ERROR: range_start/range_end must be integers", failed=True)
    with SessionLocal() as db:
        doc = db.get(Doc, doc_id)
        if doc is None or doc.project_id != context.project_id:
            return NativeAgentToolResult("ERROR: doc not found in this project", failed=True)
        content = doc.content or ""
        name = doc.name
        fmt = doc.format
    total = len(content)
    start = max(0, min(range_start, total))
    end = total if range_end is None else max(start, min(range_end, total))
    if end - start > _PROJECT_READ_LIMIT:
        end = start + _PROJECT_READ_LIMIT
    slice_text = content[start:end]
    out = {
        "doc_id": doc_id,
        "name": name,
        "format": fmt,
        "total_length": total,
        "range_start": start,
        "range_end": end,
        "content": slice_text,
        "truncated": end < total or start > 0,
    }
    return NativeAgentToolResult(json.dumps(out, ensure_ascii=False))


def _tool_project_grep(
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult:
    if not context.project_scope_ok():
        return NativeAgentToolResult("ERROR: project scope not available", failed=True)
    pattern = str(args.get("pattern") or "").strip()
    if not pattern:
        return NativeAgentToolResult("ERROR: pattern is required", failed=True)
    format_filter = str(args.get("format") or "").strip().lower()
    try:
        max_results = int(args.get("max_results") or _PROJECT_GREP_DEFAULT_LIMIT)
    except (TypeError, ValueError):
        max_results = _PROJECT_GREP_DEFAULT_LIMIT
    max_results = max(1, min(max_results, _PROJECT_GREP_HARD_LIMIT))
    try:
        regex = re.compile(pattern, re.MULTILINE)
    except re.error as exc:
        return NativeAgentToolResult(f"ERROR: invalid regex: {exc}", failed=True)
    with SessionLocal() as db:
        q = db.query(Doc.id, Doc.name, Doc.format, Doc.content).filter(
            Doc.project_id == context.project_id,
        )
        if format_filter:
            q = q.filter(Doc.format == format_filter)
        rows = q.all()
    hits: list[dict[str, Any]] = []
    for row in rows:
        content = row.content or ""
        for m in regex.finditer(content):
            line_start = content.rfind("\n", 0, m.start()) + 1
            line_end = content.find("\n", m.end())
            line_end = len(content) if line_end == -1 else line_end
            line_no = content.count("\n", 0, m.start()) + 1
            preview = content[line_start:line_end]
            if len(preview) > _PROJECT_GREP_PREVIEW_CHARS:
                cut_at = max(0, m.start() - line_start - 60)
                preview = preview[cut_at : cut_at + _PROJECT_GREP_PREVIEW_CHARS]
            hits.append(
                {
                    "doc_id": row.id,
                    "doc_name": row.name,
                    "format": row.format,
                    "offset": m.start(),
                    "line": line_no,
                    "preview": preview,
                }
            )
            if len(hits) >= max_results:
                break
        if len(hits) >= max_results:
            break
    return NativeAgentToolResult(
        json.dumps(
            {"hits": hits, "truncated": len(hits) >= max_results},
            ensure_ascii=False,
        )
    )


def _tool_project_outline(
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult:
    if not context.project_scope_ok():
        return NativeAgentToolResult("ERROR: project scope not available", failed=True)
    doc_id = _resolve_active_doc_id(args, context)
    if not doc_id:
        return NativeAgentToolResult("ERROR: doc_id is required and no active document is available", failed=True)
    with SessionLocal() as db:
        doc = db.get(Doc, doc_id)
        if doc is None or doc.project_id != context.project_id:
            return NativeAgentToolResult("ERROR: doc not found in this project", failed=True)
        content = doc.content or ""
        fmt = (doc.format or "").lower()
        name = doc.name
    sections = _extract_outline(content, fmt)
    return NativeAgentToolResult(
        json.dumps(
            {"doc_id": doc_id, "name": name, "format": fmt, "sections": sections},
            ensure_ascii=False,
        )
    )


def _resolve_active_doc_id(args: dict[str, Any], context: NativeAgentToolContext) -> str:
    return str(args.get("doc_id") or context.active_document_id or "").strip()


def _tool_project_write_text_file(
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult:
    if not context.project_scope_ok():
        return _project_write_error("ERROR: project scope not available")
    path_raw = str(args.get("path") or "")
    try:
        path_parts = _normalize_project_create_path(path_raw)
    except ValueError as exc:
        return _project_write_error(f"ERROR: {exc}")

    content = args.get("content")
    if not isinstance(content, str):
        return _project_write_error("ERROR: content must be a string")
    content_bytes = len(content.encode("utf-8"))
    if content_bytes > _PROJECT_CREATE_CONTENT_LIMIT:
        return _project_write_error(f"ERROR: content exceeds {_PROJECT_CREATE_CONTENT_LIMIT} bytes")

    name = path_parts[-1]
    try:
        doc_format = _project_doc_format_for_name(name, args.get("format"))
    except ValueError as exc:
        return _project_write_error(f"ERROR: {exc}")

    with SessionLocal() as db:
        project = db.get(Project, context.project_id)
        if project is None:
            return _project_write_error("ERROR: project not found")
        if not ProjectMemberService(db).can_write(project.id, context.user_id):
            return _project_write_error("ERROR: project write access required")

        svc = ProjectFsService(db, project)
        parent_folder_id: str | None = None
        for folder_name in path_parts[:-1]:
            conflict = _project_sibling_kind(db, project.id, parent_folder_id, folder_name)
            if conflict in {"doc", "file"}:
                return _project_write_error(
                    f"ERROR: cannot create folder '{folder_name}' because a {conflict} "
                    "with that name already exists"
                )
            folder = _project_find_folder(db, project.id, parent_folder_id, folder_name)
            if folder is None:
                try:
                    folder = svc.create_folder(
                        parent_folder_id=parent_folder_id,
                        name=folder_name,
                    )
                except ValueError as exc:
                    return _project_write_error(f"ERROR: {exc}")
            parent_folder_id = folder.id

        existing = _project_sibling_kind(db, project.id, parent_folder_id, name)
        if existing is not None:
            return _project_write_error(
                f"ERROR: cannot create '{name}' because a {existing} with that name already exists"
            )
        try:
            doc = svc.create_doc(
                folder_id=parent_folder_id,
                name=name,
                format=doc_format,
                content=content,
            )
        except ValueError as exc:
            return _project_write_error(f"ERROR: {exc}")

        payload = {
            "action": "doc.created",
            "doc_id": doc.id,
            "folder_id": doc.folder_id,
            "name": doc.name,
            "format": doc.format,
            "path": "/".join(path_parts),
            "doc": _tree_doc_payload(doc),
        }
        bus.publish(project.id, "project.tree.changed", payload, origin_client_id="")

    return NativeAgentToolResult(
        json.dumps(
            {
                "status": "created",
                "doc_id": payload["doc_id"],
                "path": payload["path"],
                "name": payload["name"],
                "format": payload["format"],
                "size_bytes": payload["doc"]["size_bytes"],
            },
            ensure_ascii=False,
        ),
        tool_kind="project_write",
        side_event={"event": "native.agent.project_file_created", "data": payload},
    )


def _project_write_error(content: str) -> NativeAgentToolResult:
    return NativeAgentToolResult(content, failed=True, tool_kind="project_write")


def _tool_propose_doc_edit(
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult:
    """Surface an edit proposal to the chat UI; never writes the doc.

    Scope is locked to the active document in the Tool Kernel context.
    """
    if not context.project_scope_ok():
        return NativeAgentToolResult("ERROR: project scope not available", failed=True)
    document_id = (context.active_document_id or "").strip()
    if not document_id:
        return NativeAgentToolResult(
            "ERROR: propose_doc_edit requires an active document; none is bound to this conversation",
            failed=True,
        )
    try:
        range_start = int(args.get("range_start"))
        range_end = int(args.get("range_end"))
    except (TypeError, ValueError):
        return NativeAgentToolResult(
            "ERROR: range_start and range_end must be integers", failed=True
        )
    new_text = args.get("new_text")
    if not isinstance(new_text, str):
        return NativeAgentToolResult("ERROR: new_text must be a string", failed=True)
    reason = str(args.get("reason") or "").strip()
    original_text_arg = args.get("original_text")

    with SessionLocal() as db:
        doc = db.get(Doc, document_id)
        if doc is None or doc.project_id != context.project_id:
            return NativeAgentToolResult(
                "ERROR: active document not found in this project", failed=True
            )
        content = doc.content or ""
    total = len(content)

    anchor_text: str | None = None
    if isinstance(original_text_arg, str) and original_text_arg.strip():
        start, end, anchor_text, err = _resolve_text_range(
            content,
            original_text_arg,
            range_start if range_start > 0 else (context.active_range_start or 0),
            range_end,
        )
        if err:
            return NativeAgentToolResult(err, failed=True)
    else:
        start = max(0, min(range_start, total))
        end = max(start, min(range_end, total))

    original_text = content[start:end]

    proposal_id = uuid.uuid4().hex
    proposal = {
        "proposal_id": proposal_id,
        "document_id": document_id,
        "range_start": start,
        "range_end": end,
        "original_text": original_text,
        "new_text": new_text,
        "reason": reason,
        "anchor_text": anchor_text,
    }

    tool_reply = {
        "status": "proposed",
        "proposal_id": proposal_id,
        "document_id": document_id,
        "range_start": start,
        "range_end": end,
        "note": (
            "Proposal queued; awaiting user approval in chat. "
            "Do not propose the same edit again — briefly explain the intent in plain text."
        ),
    }
    return NativeAgentToolResult(
        json.dumps(tool_reply, ensure_ascii=False),
        tool_kind="edit_proposal",
        side_event={"event": "native.agent.edit_proposal", "data": proposal},
    )


def _tool_create_suggestion(
    args: dict[str, Any],
    context: NativeAgentToolContext,
) -> NativeAgentToolResult:
    """Create a persistent suggestion annotation card side event."""
    if not context.project_scope_ok():
        return NativeAgentToolResult("ERROR: project scope not available", failed=True)
    document_id = (context.active_document_id or "").strip()
    if not document_id:
        return NativeAgentToolResult(
            "ERROR: create_suggestion requires an active document", failed=True
        )
    original_text_arg = args.get("original_text")
    if not isinstance(original_text_arg, str) or not original_text_arg.strip():
        return NativeAgentToolResult("ERROR: original_text is required", failed=True)
    content_arg = args.get("content")
    if not isinstance(content_arg, str) or not content_arg.strip():
        return NativeAgentToolResult("ERROR: content is required", failed=True)
    proposed_text = str(args.get("proposed_text") or "")
    reason = str(args.get("reason") or "").strip()

    try:
        range_start = int(args.get("range_start") or 0)
        range_end = int(args.get("range_end") or 0)
    except (TypeError, ValueError):
        range_start, range_end = 0, 0

    with SessionLocal() as db:
        doc = db.get(Doc, document_id)
        if doc is None or doc.project_id != context.project_id:
            return NativeAgentToolResult(
                "ERROR: active document not found in this project", failed=True
            )
        doc_content = doc.content or ""

    start, end, anchor_text, err = _resolve_text_range(
        doc_content, original_text_arg, range_start, range_end,
    )
    if err:
        return NativeAgentToolResult(err, failed=True)

    original_text = doc_content[start:end]

    suggestion_id = uuid.uuid4().hex
    suggestion = {
        "suggestion_id": suggestion_id,
        "document_id": document_id,
        "range_start": start,
        "range_end": end,
        "original_text": original_text,
        "proposed_text": proposed_text,
        "content": content_arg,
        "reason": reason,
        "anchor_text": anchor_text,
    }

    return NativeAgentToolResult(
        json.dumps(
            {"status": "created", "suggestion_id": suggestion_id},
            ensure_ascii=False,
        ),
        tool_kind="create_suggestion",
        side_event={"event": "native.agent.suggestion_created", "data": suggestion},
    )


def _resolve_text_range(
    content: str,
    original_text: str,
    range_start: int,
    range_end: int,
) -> tuple[int, int, str | None, str | None]:
    """Resolve the text range for an edit or suggestion.

    Returns ``(start, end, anchor_text, error)``. On success ``error`` is
    ``None``; on failure ``start/end`` are 0 and ``error`` contains the
    error message.
    """
    anchor = original_text
    anchor_text: str | None = anchor

    occurrences: list[int] = []
    pos = 0
    while True:
        idx = content.find(anchor, pos)
        if idx == -1:
            break
        occurrences.append(idx)
        pos = idx + 1

    if len(occurrences) == 1:
        return occurrences[0], occurrences[0] + len(anchor), anchor_text, None
    if len(occurrences) > 1:
        hint = range_start if range_start > 0 else 0
        if hint > 0:
            closest = min(occurrences, key=lambda x: abs(x - hint))
            return closest, closest + len(anchor), anchor_text, None
        return 0, 0, None, (
            f"ERROR: original_text appears {len(occurrences)} times "
            f"in the document. Select the target text in the editor "
            f"so the system can disambiguate."
        )

    fuzzy_pos = _fuzzy_find(content, anchor, threshold=0.85)
    if fuzzy_pos is not None:
        return fuzzy_pos, fuzzy_pos + len(anchor), anchor_text, None
    return 0, 0, None, (
        "ERROR: original_text not found in document. "
        "The document may have changed. Please call project_read_doc "
        "to re-read the current content and try again."
    )


def _fuzzy_find(content: str, anchor: str, threshold: float = 0.85) -> int | None:
    """Find the position in *content* most similar to *anchor*."""
    from difflib import SequenceMatcher

    anchor_len = len(anchor)
    if anchor_len == 0:
        return None
    best_ratio = 0.0
    best_pos: int | None = None
    step = max(1, anchor_len // 4)
    for i in range(0, len(content) - anchor_len + 1, step):
        window = content[i : i + anchor_len]
        ratio = SequenceMatcher(None, anchor, window).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_pos = i
            if ratio >= 0.95:
                break
    if best_ratio >= threshold and best_pos is not None:
        return best_pos
    return None


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
            raise ValueError(
                f"path segment exceeds {_PROJECT_CREATE_MAX_SEGMENT_CHARS} characters"
            )
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
    db: Any,
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
    db: Any,
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
        "updated_at": doc.updated_at.isoformat(),
    }


_LATEX_HEAD_RE = re.compile(
    r"^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*\{([^}]*)\}",
    re.MULTILINE,
)
_MARKDOWN_HEAD_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
_LATEX_LEVEL = {
    "part": 0,
    "chapter": 1,
    "section": 2,
    "subsection": 3,
    "subsubsection": 4,
    "paragraph": 5,
    "subparagraph": 6,
}


def _extract_outline(content: str, fmt: str) -> list[dict[str, Any]]:
    if fmt == "tex":
        regex = _LATEX_HEAD_RE
        out: list[dict[str, Any]] = []
        for m in regex.finditer(content):
            kind = m.group(1)
            out.append(
                {
                    "level": _LATEX_LEVEL.get(kind, 3),
                    "kind": kind,
                    "title": m.group(2).strip(),
                    "offset": m.start(),
                }
            )
        return out
    if fmt == "md":
        out = []
        for m in _MARKDOWN_HEAD_RE.finditer(content):
            out.append(
                {
                    "level": len(m.group(1)),
                    "kind": "h" + str(len(m.group(1))),
                    "title": m.group(2).strip(),
                    "offset": m.start(),
                }
            )
        return out
    return []

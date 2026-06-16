"""Project/document read commands for Agent-facing integrations."""

from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Doc, Project
from ..services.native_agent_tool_kernel import _extract_outline
from ..services.project_grep_policy import GREP_MAX_DOC_CHARS, validate_grep_pattern
from ..services.project_member_service import ProjectMemberService
from ..services.project_service import ProjectService
from .context import AgentCommandContext, AgentCommandResult

READ_LIMIT = 20_000
LIST_LIMIT = 500
GREP_DEFAULT_LIMIT = 50
GREP_HARD_LIMIT = 200
GREP_PREVIEW_CHARS = 240


def list_projects(db: Session, ctx: AgentCommandContext, args: dict[str, Any]) -> AgentCommandResult:
    type_filter = str(args.get("project_type") or "all").strip().lower()
    svc = ProjectService(db)
    member_svc = ProjectMemberService(db)
    pairs: list[tuple[Project, str]] = [(project, "owner") for project in svc.list(user_id=ctx.user_id)]
    for project, member in member_svc.list_shared_projects(ctx.user_id):
        if project.user_id != ctx.user_id:
            pairs.append((project, member.role))
    if type_filter not in ("", "all"):
        pairs = [
            (project, role)
            for project, role in pairs
            if (project.project_type or "paper").lower() == type_filter
        ]
    return AgentCommandResult(
        payload={"projects": [_project_payload(project, role) for project, role in pairs]},
        next_context=ctx,
    )


def select_project(db: Session, ctx: AgentCommandContext, args: dict[str, Any]) -> AgentCommandResult:
    project = require_project_access(db, str(args.get("project_id") or ""), ctx.user_id)
    role = ProjectMemberService(db).get_role(project.id, ctx.user_id) or "viewer"
    return AgentCommandResult(
        payload={"project": _project_payload(project, role)},
        next_context=ctx.with_active_project(project.id),
    )


def list_docs(db: Session, ctx: AgentCommandContext, args: dict[str, Any]) -> AgentCommandResult:
    project = project_from_args(db, ctx, args)
    rows = (
        db.query(Doc)
        .filter(Doc.project_id == project.id)
        .order_by(Doc.name.asc())
        .limit(LIST_LIMIT)
        .all()
    )
    return AgentCommandResult(
        payload={
            "docs": [
                {
                    "id": doc.id,
                    "name": doc.name,
                    "format": doc.format,
                    "folder_id": doc.folder_id or "",
                    "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
                }
                for doc in rows
            ]
        },
        next_context=ctx,
    )


def read_doc(db: Session, ctx: AgentCommandContext, args: dict[str, Any]) -> AgentCommandResult:
    project = project_from_args(db, ctx, args)
    doc = require_doc(db, project.id, str(args.get("doc_id") or ""))
    content = doc.content or ""
    total = len(content)
    start = max(0, min(_int(args.get("range_start"), 0), total))
    end_arg = args.get("range_end")
    end = total if end_arg is None else max(start, min(_int(end_arg, total), total))
    if end - start > READ_LIMIT:
        end = start + READ_LIMIT
    return AgentCommandResult(
        payload={
            "doc_id": doc.id,
            "name": doc.name,
            "format": doc.format,
            "total_length": total,
            "range_start": start,
            "range_end": end,
            "content": content[start:end],
            "truncated": end < total or start > 0,
        },
        next_context=ctx,
    )


def grep(db: Session, ctx: AgentCommandContext, args: dict[str, Any]) -> AgentCommandResult:
    project = project_from_args(db, ctx, args)
    pattern = str(args.get("pattern") or "")
    if not pattern:
        raise HTTPException(400, "pattern is required")
    if pattern_error := validate_grep_pattern(pattern):
        raise HTTPException(400, pattern_error)
    try:
        regex = re.compile(pattern, re.MULTILINE)
    except re.error as exc:
        raise HTTPException(400, f"invalid regex: {exc}") from exc

    max_results = min(max(_int(args.get("max_results"), GREP_DEFAULT_LIMIT), 1), GREP_HARD_LIMIT)
    fmt = str(args.get("format") or "").strip().lower()
    query = db.query(Doc).filter(Doc.project_id == project.id)
    if fmt:
        query = query.filter(Doc.format == fmt)

    hits: list[dict[str, Any]] = []
    for doc in query.all():
        content = doc.content or ""
        if len(content) > GREP_MAX_DOC_CHARS:
            continue
        for match in regex.finditer(content):
            line_start = content.rfind("\n", 0, match.start()) + 1
            line_end = content.find("\n", match.end())
            line_end = len(content) if line_end == -1 else line_end
            preview = content[line_start:line_end]
            if len(preview) > GREP_PREVIEW_CHARS:
                cut_at = max(0, match.start() - line_start - 60)
                preview = preview[cut_at : cut_at + GREP_PREVIEW_CHARS]
            hits.append(
                {
                    "doc_id": doc.id,
                    "doc_name": doc.name,
                    "format": doc.format,
                    "offset": match.start(),
                    "line": content.count("\n", 0, match.start()) + 1,
                    "preview": preview,
                }
            )
            if len(hits) >= max_results:
                break
        if len(hits) >= max_results:
            break
    return AgentCommandResult(payload={"hits": hits, "truncated": len(hits) >= max_results}, next_context=ctx)


def outline(db: Session, ctx: AgentCommandContext, args: dict[str, Any]) -> AgentCommandResult:
    project = project_from_args(db, ctx, args)
    doc = require_doc(db, project.id, str(args.get("doc_id") or ""))
    fmt = (doc.format or "").lower()
    sections = [
        {"level": int(s.get("level", 3)), "title": str(s.get("title", "")), "offset": int(s.get("offset", 0))}
        for s in _extract_outline(doc.content or "", fmt)
    ]
    return AgentCommandResult(
        payload={"doc_id": doc.id, "name": doc.name, "format": fmt, "sections": sections},
        next_context=ctx,
    )


def require_project_access(db: Session, project_id: str, user_id: str) -> Project:
    project = db.get(Project, project_id)
    if project is None or not ProjectMemberService(db).has_access(project_id, user_id):
        raise HTTPException(404, "Project not found")
    return project


def project_from_args(db: Session, ctx: AgentCommandContext, args: dict[str, Any]) -> Project:
    project_id = str(args.get("project_id") or ctx.active_project_id or "")
    if not project_id:
        raise HTTPException(400, "project_id is required; call superleaf_select_project first")
    return require_project_access(db, project_id, ctx.user_id)


def require_doc(db: Session, project_id: str, doc_id: str) -> Doc:
    doc = db.get(Doc, doc_id)
    if doc is None or doc.project_id != project_id:
        raise HTTPException(404, "doc not found in this project")
    return doc


def _project_payload(project: Project, role: str) -> dict[str, Any]:
    return {
        "id": project.id,
        "name": project.name,
        "project_type": project.project_type or "paper",
        "my_role": role,
        "main_doc_id": project.main_doc_id or "",
        "updated_at": project.updated_at.isoformat() if project.updated_at else None,
    }


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

"""Suggestion-oriented Agent write commands."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Annotation, Doc, Project
from ..services.event_bus import bus
from ..services.project_member_service import ProjectMemberService
from .anchors import AnchorResolution, resolve_text_anchor
from .context import AgentCommandContext, AgentCommandResult
from .project import project_from_args, require_doc


def require_agent_write(db: Session, ctx: AgentCommandContext, project_id: str) -> None:
    if not ctx.can_write:
        raise HTTPException(403, "This Agent command context is read-only")
    if not ProjectMemberService(db).can_write(project_id, ctx.user_id):
        raise HTTPException(403, "Read-only project access")


def propose_doc_edit(db: Session, ctx: AgentCommandContext, args: dict[str, Any]) -> AgentCommandResult:
    project = project_from_args(db, ctx, args)
    require_agent_write(db, ctx, project.id)
    doc = require_doc(db, project.id, str(args.get("doc_id") or ""))
    start = _int(args.get("range_start"), 0)
    end = _int(args.get("range_end"), start)
    new_text = args.get("new_text")
    if not isinstance(new_text, str):
        raise HTTPException(400, "new_text must be a string")
    content = doc.content or ""
    original = str(args.get("original_text") or _slice(content, start, end))
    resolution = resolve_text_anchor(content, original, start, end)
    annotation = _new_suggestion(
        ctx,
        project,
        doc,
        resolution,
        new_text,
        str(args.get("reason") or ""),
        str(args.get("reason") or "Edit proposal"),
    )
    db.add(annotation)
    db.commit()
    bus.publish(project.id, "annotation.created", {"annotation_id": annotation.id}, origin_client_id="")
    payload = {
        "status": "proposed",
        "proposal_id": annotation.id,
        "doc_id": doc.id,
        "document_id": doc.id,
        **resolution.payload(),
    }
    return AgentCommandResult(
        payload=payload,
        next_context=ctx,
        side_effects=[
            {"event": "annotation.created", "project_id": project.id, "annotation_id": annotation.id}
        ],
    )


def create_suggestion(db: Session, ctx: AgentCommandContext, args: dict[str, Any]) -> AgentCommandResult:
    project = project_from_args(db, ctx, args)
    require_agent_write(db, ctx, project.id)
    doc = require_doc(db, project.id, str(args.get("doc_id") or ""))
    original = str(args.get("original_text") or "")
    content = str(args.get("content") or "")
    if not original or not content:
        raise HTTPException(400, "original_text and content are required")
    start = _int(args.get("range_start"), 0)
    default_end = start + len(original) if "range_start" in args or "range_end" in args else start
    end = _int(args.get("range_end"), default_end)
    resolution = resolve_text_anchor(doc.content or "", original, start, end)
    annotation = _new_suggestion(
        ctx,
        project,
        doc,
        resolution,
        str(args.get("proposed_text") or ""),
        str(args.get("reason") or ""),
        content,
    )
    db.add(annotation)
    db.commit()
    bus.publish(project.id, "annotation.created", {"annotation_id": annotation.id}, origin_client_id="")
    payload = {
        "status": "created",
        "suggestion_id": annotation.id,
        "doc_id": doc.id,
        "document_id": doc.id,
        **resolution.payload(),
    }
    return AgentCommandResult(
        payload=payload,
        next_context=ctx,
        side_effects=[
            {"event": "annotation.created", "project_id": project.id, "annotation_id": annotation.id}
        ],
    )


def _new_suggestion(
    ctx: AgentCommandContext,
    project: Project,
    doc: Doc,
    resolution: AnchorResolution,
    proposed: str,
    reason: str,
    content: str,
) -> Annotation:
    now = datetime.now(UTC).replace(tzinfo=None)
    return Annotation(
        id=uuid.uuid4().hex,
        doc_id=doc.id,
        project_id=project.id,
        user_id=ctx.user_id,
        kind="suggestion",
        status="pending",
        range_from=resolution.range_from,
        range_to=resolution.range_to,
        target_text=resolution.text,
        content=content,
        original=resolution.text,
        proposed=proposed,
        reason=reason,
        agent_name="SuperLeaf MCP" if ctx.source == "mcp" else "SuperLeaf Agent",
        thread=[],
        attached_files=[],
        created_at=now,
        updated_at=now,
    )


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _slice(content: str, start: int, end: int) -> str:
    safe_start = max(0, min(start, len(content)))
    safe_end = max(safe_start, min(end, len(content)))
    return content[safe_start:safe_end]

"""Project file creation commands for Agent-facing integrations."""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Doc, FileBlob, Folder
from ..services.event_bus import bus
from ..services.project_fs_service import ProjectFsService, doc_format_for_name
from .context import AgentCommandContext, AgentCommandResult
from .project import project_from_args
from .suggestions import require_agent_write


def project_create_text_file(
    db: Session,
    ctx: AgentCommandContext,
    args: dict[str, Any],
) -> AgentCommandResult:
    project = project_from_args(db, ctx, args)
    require_agent_write(db, ctx, project.id)
    raw_path = str(args.get("path") or "").strip()
    content = args.get("content")
    if not raw_path or raw_path.startswith("/"):
        raise HTTPException(400, "path must be a relative project path")
    if not isinstance(content, str):
        raise HTTPException(400, "content must be a string")
    parts = [part for part in PurePosixPath(raw_path).parts if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise HTTPException(400, "path must stay inside the project")

    fs = ProjectFsService(db, project)
    parent_id: str | None = None
    for folder_name in parts[:-1]:
        _ensure_no_doc_or_file_sibling(db, project.id, parent_id, folder_name)
        parent_id = fs.create_folder(parent_folder_id=parent_id, name=folder_name).id

    name = parts[-1]
    if _sibling_kind(db, project.id, parent_id, name):
        raise HTTPException(409, f"cannot create '{name}' because an entry with that name already exists")
    fmt = str(args.get("format") or doc_format_for_name(name))
    if fmt not in {"tex", "md", "txt"}:
        fmt = doc_format_for_name(name)
    doc = fs.create_doc(folder_id=parent_id, name=name, format=fmt, content=content)
    bus.publish(
        project.id,
        "project.tree.changed",
        {"action": "doc.created", "doc_id": doc.id},
        origin_client_id="",
    )
    return AgentCommandResult(
        payload={
            "status": "created",
            "doc_id": doc.id,
            "path": "/".join(parts),
            "name": doc.name,
            "format": doc.format,
            "size_bytes": len((doc.content or "").encode("utf-8")),
        },
        next_context=ctx,
        side_effects=[{"event": "project.tree.changed", "project_id": project.id, "doc_id": doc.id}],
    )


def _sibling_kind(db: Session, project_id: str, folder_id: str | None, name: str) -> str:
    filters = {"project_id": project_id, "folder_id": folder_id, "name": name}
    if db.query(Doc).filter_by(**filters).first():
        return "doc"
    if db.query(FileBlob).filter_by(**filters).first():
        return "file"
    if db.query(Folder).filter_by(project_id=project_id, parent_folder_id=folder_id, name=name).first():
        return "folder"
    return ""


def _ensure_no_doc_or_file_sibling(db: Session, project_id: str, folder_id: str | None, name: str) -> None:
    kind = _sibling_kind(db, project_id, folder_id, name)
    if kind and kind != "folder":
        raise HTTPException(
            409,
            f"cannot create folder '{name}' because a {kind} with that name already exists",
        )

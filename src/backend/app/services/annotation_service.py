"""Annotation persistence service.

Server-side source of truth for annotation cards. The frontend used to keep
these in a zustand persist store, but that made cross-device sync and
multi-account collaboration impossible (each browser had its own private
copy). Now the cards live here and are streamed to all subscribed clients
over the project event bus.
"""

from __future__ import annotations

from datetime import datetime
from typing import Iterable

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models import Annotation


def list_by_doc(db: Session, doc_id: str, *, user_id: str = "") -> list[Annotation]:
    """Return global annotations (is_global=True) plus the given user's private ones."""
    q = db.query(Annotation).filter(Annotation.doc_id == doc_id)
    if user_id:
        q = q.filter(or_(Annotation.is_global == True, Annotation.user_id == user_id))  # noqa: E712
    return q.order_by(Annotation.created_at.asc(), Annotation.id.asc()).all()


def get(db: Session, annotation_id: str) -> Annotation | None:
    return db.get(Annotation, annotation_id)


def upsert(
    db: Session,
    *,
    annotation_id: str,
    doc_id: str,
    project_id: str,
    user_id: str = "",
    is_global: bool = False,
    kind: str,
    status: str,
    range_from: int,
    range_to: int,
    target_text: str,
    content: str,
    severity: str,
    workflow_id: str,
    agent_name: str,
    conversation_id: str,
    original: str,
    proposed: str,
    reason: str,
    risk_type: str,
    mitigation: str,
    thread: list,
    attached_files: list,
    created_at: datetime,
) -> tuple[Annotation, bool]:
    """Insert or update by id. Returns (row, created).

    Idempotent: re-running the same `POST /api/annotations` returns the
    existing row instead of 409ing — this matches the frontend's optimistic
    UI flow where a retry after a flaky network shouldn't fail.
    """
    existing = db.get(Annotation, annotation_id)
    if existing is not None:
        # Selectively update mutable fields; preserve doc_id / project_id / id.
        existing.kind = kind
        existing.status = status
        existing.range_from = range_from
        existing.range_to = range_to
        existing.target_text = target_text
        existing.content = content
        existing.severity = severity
        existing.workflow_id = workflow_id
        existing.agent_name = agent_name
        existing.conversation_id = conversation_id
        existing.original = original
        existing.proposed = proposed
        existing.reason = reason
        existing.risk_type = risk_type
        existing.mitigation = mitigation
        existing.thread = thread
        existing.attached_files = attached_files
        existing.updated_at = datetime.utcnow()
        db.flush()
        return existing, False

    row = Annotation(
        id=annotation_id,
        doc_id=doc_id,
        project_id=project_id,
        user_id=user_id,
        is_global=is_global,
        kind=kind,
        status=status,
        range_from=range_from,
        range_to=range_to,
        target_text=target_text,
        content=content,
        severity=severity,
        workflow_id=workflow_id,
        agent_name=agent_name,
        conversation_id=conversation_id,
        original=original,
        proposed=proposed,
        reason=reason,
        risk_type=risk_type,
        mitigation=mitigation,
        thread=thread,
        attached_files=attached_files,
        created_at=created_at,
    )
    db.add(row)
    db.flush()
    return row, True


def patch(
    db: Session,
    row: Annotation,
    *,
    status: str | None = None,
    range_from: int | None = None,
    range_to: int | None = None,
    content: str | None = None,
    thread: list | None = None,
    publish: bool | None = None,
    acting_user_id: str = "",
) -> Annotation:
    if status is not None:
        row.status = status
    if range_from is not None:
        row.range_from = range_from
    if range_to is not None:
        row.range_to = range_to
    if content is not None:
        row.content = content
    if thread is not None:
        row.thread = thread
    if publish is True:
        row.is_global = True
    elif publish is False:
        row.is_global = False
    row.updated_at = datetime.utcnow()
    db.flush()
    return row


def delete(db: Session, row: Annotation) -> None:
    db.delete(row)
    db.flush()


def to_dict(row: Annotation) -> dict:
    """Plain dict for SSE payloads (avoids importing pydantic in the bus)."""
    return {
        "id": row.id,
        "doc_id": row.doc_id,
        "project_id": row.project_id,
        "user_id": row.user_id,
        "is_global": row.is_global,
        "kind": row.kind,
        "status": row.status,
        "range_from": row.range_from,
        "range_to": row.range_to,
        "target_text": row.target_text,
        "content": row.content,
        "severity": row.severity,
        "workflow_id": row.workflow_id,
        "agent_name": row.agent_name,
        "conversation_id": row.conversation_id,
        "original": row.original,
        "proposed": row.proposed,
        "reason": row.reason,
        "risk_type": row.risk_type,
        "mitigation": row.mitigation,
        "thread": row.thread or [],
        "attached_files": row.attached_files or [],
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }

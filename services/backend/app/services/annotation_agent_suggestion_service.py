"""Private Agent suggestions for annotations.

This service keeps Agent-generated auto-reply advice outside the shared
annotation thread. Suggestions are scoped to one user, one Agent, and one
annotation, so collaborators can process the same global comment without
seeing each other's private drafts.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..models import Annotation, AnnotationAgentSuggestion

VISIBLE_STATUSES = {"drafted", "stale", "ready", "published", "failed"}
TERMINAL_ANNOTATION_STATUSES = {"archived", "deleted", "superseded"}


def compute_annotation_source_hash(row: Annotation) -> str:
    payload = {
        "id": row.id,
        "kind": row.kind,
        "status": row.status,
        "range_from": row.range_from,
        "range_to": row.range_to,
        "target_text": row.target_text or "",
        "content": row.content or "",
        "thread": _json_ready(row.thread or []),
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def list_by_doc(
    db: Session,
    doc_id: str,
    *,
    user_id: str,
) -> list[AnnotationAgentSuggestion]:
    return (
        db.query(AnnotationAgentSuggestion)
        .filter(
            AnnotationAgentSuggestion.doc_id == doc_id,
            AnnotationAgentSuggestion.user_id == user_id,
        )
        .order_by(
            AnnotationAgentSuggestion.updated_at.desc(),
            AnnotationAgentSuggestion.id.asc(),
        )
        .all()
    )


def get_for_user(
    db: Session,
    suggestion_id: str,
    *,
    user_id: str,
) -> AnnotationAgentSuggestion | None:
    row = db.get(AnnotationAgentSuggestion, suggestion_id)
    if row is None or row.user_id != user_id:
        return None
    return row


def get_for_annotation_agent(
    db: Session,
    *,
    annotation_id: str,
    user_id: str,
    agent_id: str,
) -> AnnotationAgentSuggestion | None:
    return (
        db.query(AnnotationAgentSuggestion)
        .filter(
            AnnotationAgentSuggestion.annotation_id == annotation_id,
            AnnotationAgentSuggestion.user_id == user_id,
            AnnotationAgentSuggestion.agent_id == agent_id,
        )
        .first()
    )


def existing_for_annotations(
    db: Session,
    *,
    annotation_ids: list[str],
    user_id: str,
    agent_id: str,
) -> dict[str, AnnotationAgentSuggestion]:
    if not annotation_ids:
        return {}
    rows = (
        db.query(AnnotationAgentSuggestion)
        .filter(
            AnnotationAgentSuggestion.annotation_id.in_(annotation_ids),
            AnnotationAgentSuggestion.user_id == user_id,
            AnnotationAgentSuggestion.agent_id == agent_id,
        )
        .all()
    )
    return {row.annotation_id: row for row in rows}


def mark_stale_for_annotation(db: Session, row: Annotation) -> int:
    source_hash = compute_annotation_source_hash(row)
    rows = (
        db.query(AnnotationAgentSuggestion)
        .filter(AnnotationAgentSuggestion.annotation_id == row.id)
        .all()
    )
    changed = 0
    now = datetime.utcnow()
    for suggestion in rows:
        if suggestion.source_hash == source_hash or suggestion.status == "stale":
            continue
        suggestion.status = "stale"
        suggestion.updated_at = now
        changed += 1
    if changed:
        db.flush()
    return changed


def should_process_annotation(
    annotation: Annotation,
    existing: AnnotationAgentSuggestion | None,
    *,
    source_hash: str,
    include_stale: bool,
) -> bool:
    if annotation.status in TERMINAL_ANNOTATION_STATUSES:
        return False
    if existing is None:
        return True
    if existing.source_hash != source_hash:
        return True
    if existing.status == "stale":
        return include_stale
    if existing.status == "failed":
        return True
    return False


def upsert_generated(
    db: Session,
    *,
    project_id: str,
    doc_id: str,
    annotation_id: str,
    user_id: str,
    agent_id: str,
    source_hash: str,
    suggestions: list[str],
    internal_meta: dict[str, Any] | None = None,
    error: str = "",
    status: str = "drafted",
) -> AnnotationAgentSuggestion:
    row = get_for_annotation_agent(
        db,
        annotation_id=annotation_id,
        user_id=user_id,
        agent_id=agent_id,
    )
    now = datetime.utcnow()
    if row is None:
        row = AnnotationAgentSuggestion(
            project_id=project_id,
            doc_id=doc_id,
            annotation_id=annotation_id,
            user_id=user_id,
            agent_id=agent_id,
            source_hash=source_hash,
            status=status,
            suggestions=suggestions,
            internal_meta=internal_meta or {},
            error=error,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
    else:
        row.project_id = project_id
        row.doc_id = doc_id
        row.source_hash = source_hash
        row.status = status
        row.suggestions = suggestions
        row.internal_meta = internal_meta or {}
        row.error = error
        row.updated_at = now
    db.flush()
    return row


def patch_for_user(
    db: Session,
    row: AnnotationAgentSuggestion,
    *,
    status: str | None = None,
    suggestions: list[str] | None = None,
) -> AnnotationAgentSuggestion:
    if status is not None:
        row.status = status
    if suggestions is not None:
        row.suggestions = _clean_suggestions(suggestions)
    row.updated_at = datetime.utcnow()
    db.flush()
    return row


def delete(db: Session, row: AnnotationAgentSuggestion) -> None:
    db.delete(row)
    db.flush()


def _clean_suggestions(values: list[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        out.append(text[:1000])
        if len(out) >= 3:
            break
    return out


def _json_ready(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_ready(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_ready(item) for item in value]
    if isinstance(value, datetime):
        return value.isoformat()
    return value

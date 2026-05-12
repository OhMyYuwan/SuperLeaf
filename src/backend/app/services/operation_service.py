"""Operation audit log (V3 Phase 3 task 3.3).

Append-only event stream of user/agent actions against a Doc. Records flow in
from two places:
  * Backend version routes record `restore` / `label_add` / `label_remove`
    inline with the underlying mutation.
  * Frontend annotation store POSTs `accept_suggestion` / `reject_suggestion`
    because annotations are client-side state in V3 (no backend annotation
    table); the operation row is the only persisted trace of that decision.

Read paths are time-ordered (newest first) and pagination is keep-it-simple:
LIMIT + offset, capped at 200 per page.
"""

from __future__ import annotations

from sqlalchemy import desc
from sqlalchemy.orm import Session

from ..models import Operation


ALLOWED_TYPES = {
    "accept_suggestion",
    "reject_suggestion",
    "restore",
    "label_add",
    "label_remove",
}

MAX_LIMIT = 200


def record(
    db: Session,
    doc_id: str,
    op_type: str,
    payload: dict | None = None,
    actor: str | None = None,
) -> Operation:
    """Append an operation row. Caller is responsible for committing the
    surrounding transaction — we flush so callers reading right after see
    the row, but we do NOT commit (lets us batch with the parent mutation).
    """
    if op_type not in ALLOWED_TYPES:
        raise ValueError(f"invalid operation type: {op_type!r}")
    row = Operation(
        doc_id=doc_id,
        type=op_type,
        payload=payload or {},
        actor=actor,
    )
    db.add(row)
    db.flush()
    return row


def list_for_doc(
    db: Session,
    doc_id: str,
    *,
    limit: int = 50,
    offset: int = 0,
) -> list[Operation]:
    limit = max(1, min(limit, MAX_LIMIT))
    offset = max(0, offset)
    return (
        db.query(Operation)
        .filter(Operation.doc_id == doc_id)
        .order_by(desc(Operation.created_at), desc(Operation.id))
        .offset(offset)
        .limit(limit)
        .all()
    )

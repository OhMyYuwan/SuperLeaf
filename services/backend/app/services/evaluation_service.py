"""Annotation evaluation + review-status service (V3 Phase 4 task 4.1+4.2).

Annotations themselves still live in the frontend zustand store, so this
service deliberately treats `annotation_id` as opaque string.

Two tables:
  - `annotation_evaluations` — user ✅/❎ verdict per Agent output, with
    captured context (document_hash, section, surrounding text excerpts,
    workflow_id, optionally workflow_run_id pulled from Operation log).
  - `annotation_review_states` — per-annotation `open / considered /
    addressed / dismissed` flag, orthogonal to the frontend
    AnnotationItem.status which tracks archive/delete.

`enrich_context` looks at the most recent Operation row carrying
matching annotation_id and copies workflow_id / workflow_run_id into the
evaluation context — this lets training-candidate exports replay the run
later without the frontend having to remember the run id.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from datetime import datetime

from sqlalchemy import desc, func
from sqlalchemy.orm import Session

from ..models import AnnotationEvaluation, AnnotationReviewState, Operation

# --------------------------------------------------------------------------
# Evaluation CRUD
# --------------------------------------------------------------------------


def list_evaluations_by_doc(db: Session, doc_id: str, *, user_id: str = "") -> list[AnnotationEvaluation]:
    q = db.query(AnnotationEvaluation).filter(AnnotationEvaluation.doc_id == doc_id)
    if user_id:
        q = q.filter(AnnotationEvaluation.user_id == user_id)
    return q.order_by(AnnotationEvaluation.created_at.asc(), AnnotationEvaluation.id.asc()).all()


def list_evaluations_for_annotation(
    db: Session, annotation_id: str
) -> list[AnnotationEvaluation]:
    return (
        db.query(AnnotationEvaluation)
        .filter(AnnotationEvaluation.annotation_id == annotation_id)
        .order_by(AnnotationEvaluation.created_at.asc())
        .all()
    )


def get_evaluation(db: Session, evaluation_id: str) -> AnnotationEvaluation | None:
    return db.get(AnnotationEvaluation, evaluation_id)


def create_evaluation(
    db: Session,
    *,
    annotation_id: str,
    doc_id: str,
    eid: str,
    target_type: str,
    target_id: str,
    verdict: str,
    reason: str,
    tags: list[str],
    adoption: str,
    training_candidate: bool,
    context: dict,
    user_id: str = "",
) -> AnnotationEvaluation:
    enriched_context = enrich_context(db, annotation_id, context)
    row = AnnotationEvaluation(
        id=eid,
        annotation_id=annotation_id,
        doc_id=doc_id,
        user_id=user_id,
        target_type=target_type,
        target_id=target_id,
        verdict=verdict,
        reason=reason,
        tags=_normalize_tags(tags),
        adoption=adoption,
        training_candidate=training_candidate,
        context=enriched_context,
    )
    db.add(row)
    db.flush()
    return row


def update_evaluation(
    db: Session,
    evaluation: AnnotationEvaluation,
    *,
    verdict: str | None = None,
    reason: str | None = None,
    tags: list[str] | None = None,
    adoption: str | None = None,
    training_candidate: bool | None = None,
    context: dict | None = None,
) -> AnnotationEvaluation:
    if verdict is not None:
        evaluation.verdict = verdict
    if reason is not None:
        evaluation.reason = reason
    if tags is not None:
        evaluation.tags = _normalize_tags(tags)
    if adoption is not None:
        evaluation.adoption = adoption
    if training_candidate is not None:
        evaluation.training_candidate = training_candidate
    if context is not None:
        evaluation.context = enrich_context(db, evaluation.annotation_id, context)
    evaluation.updated_at = datetime.utcnow()
    db.flush()
    return evaluation


def delete_evaluation(db: Session, evaluation: AnnotationEvaluation) -> None:
    db.delete(evaluation)
    db.flush()


# --------------------------------------------------------------------------
# Review status
# --------------------------------------------------------------------------


class ReviewStateScopeError(ValueError):
    """Raised when an existing review state belongs to a different scope."""


def set_review_status(
    db: Session,
    *,
    annotation_id: str,
    doc_id: str,
    status: str,
    user_id: str = "",
) -> AnnotationReviewState:
    row = db.get(AnnotationReviewState, annotation_id)
    if row is None:
        row = AnnotationReviewState(
            annotation_id=annotation_id,
            doc_id=doc_id,
            user_id=user_id,
            status=status,
        )
        db.add(row)
    else:
        if row.user_id != user_id or row.doc_id != doc_id:
            raise ReviewStateScopeError("review state not found")
        row.status = status
        row.updated_at = datetime.utcnow()
    db.flush()
    return row


def list_review_states_by_doc(db: Session, doc_id: str, *, user_id: str = "") -> list[AnnotationReviewState]:
    q = db.query(AnnotationReviewState).filter(AnnotationReviewState.doc_id == doc_id)
    if user_id:
        q = q.filter(AnnotationReviewState.user_id == user_id)
    return q.all()


# --------------------------------------------------------------------------
# Tag aggregate + context enrichment
# --------------------------------------------------------------------------


def aggregate_tags_for_doc(
    db: Session, doc_id: str, *, user_id: str = "", limit: int = 100
) -> list[str]:
    """Distinct tags across this doc's visible evaluations, frequency desc."""
    q = db.query(AnnotationEvaluation.tags).filter(
        AnnotationEvaluation.doc_id == doc_id
    )
    if user_id:
        q = q.filter(AnnotationEvaluation.user_id == user_id)
    rows = q.all()
    counts: Counter[str] = Counter()
    for (tags,) in rows:
        if not tags:
            continue
        for tag in tags:
            cleaned = (tag or "").strip().lstrip("#").strip()
            if cleaned:
                counts[cleaned] += 1
    return [t for t, _ in counts.most_common(limit)]


def enrich_context(db: Session, annotation_id: str, context: dict) -> dict:
    """Copy workflow_id / workflow_run_id from the most recent Operation
    matching this annotation_id into the evaluation context, unless the
    frontend already filled them in.

    The Operation table is fed by the frontend annotation store on
    accept/reject. We use it as a passive index from annotation_id to
    workflow run metadata.
    """
    out = dict(context or {})
    needs_workflow = not out.get("workflow_id")
    needs_run = not out.get("workflow_run_id")
    if not needs_workflow and not needs_run:
        return out

    op = (
        db.query(Operation)
        .filter(
            Operation.type.in_(("accept_suggestion", "reject_suggestion")),
            func.json_extract(Operation.payload, "$.annotation_id") == annotation_id,
        )
        .order_by(desc(Operation.created_at))
        .first()
    )
    if op is None:
        return out
    payload = op.payload or {}
    if needs_workflow:
        wf = payload.get("workflow_id")
        if wf:
            out["workflow_id"] = wf
    if needs_run:
        run = payload.get("workflow_run_id")
        if run:
            out["workflow_run_id"] = run
    return out


# --------------------------------------------------------------------------
# Orchestrator hook (Phase 4.3)
# --------------------------------------------------------------------------


def review_summary_for_doc(
    db: Session,
    doc_id: str,
    *,
    user_id: str = "",
    evaluations_per_annotation: int = 3,
) -> list[dict]:
    """Return a compact summary of review state + recent evaluations per
    annotation, suitable for inclusion in Agent input. Only annotations
    that have a review_state row OR at least one evaluation are returned —
    so untouched annotations don't bloat the prompt.

    Shape:
      [
        {
          "annotation_id": "...",
          "review_status": "dismissed" | "open" | ...,
          "evaluations": [{"verdict": "negative", "tags": [...], "reason": "..."}]
        }, ...
      ]
    """
    states = {
        s.annotation_id: s.status
        for s in list_review_states_by_doc(db, doc_id, user_id=user_id)
    }
    q = db.query(AnnotationEvaluation).filter(AnnotationEvaluation.doc_id == doc_id)
    if user_id:
        q = q.filter(AnnotationEvaluation.user_id == user_id)
    evals_rows = q.order_by(
        AnnotationEvaluation.annotation_id.asc(),
        AnnotationEvaluation.created_at.desc(),
    ).all()
    grouped: dict[str, list[AnnotationEvaluation]] = {}
    for row in evals_rows:
        grouped.setdefault(row.annotation_id, []).append(row)

    annotation_ids = set(states.keys()) | set(grouped.keys())
    summary: list[dict] = []
    for ann_id in annotation_ids:
        recent = grouped.get(ann_id, [])[:evaluations_per_annotation]
        summary.append(
            {
                "annotation_id": ann_id,
                "review_status": states.get(ann_id, "open"),
                "evaluations": [
                    {
                        "verdict": e.verdict,
                        "tags": e.tags or [],
                        "reason": (e.reason or "")[:200],
                    }
                    for e in recent
                ],
            }
        )
    return summary


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _normalize_tags(tags: Iterable[str]) -> list[str]:
    """Mirror frontend `normalizeTagList`: strip leading '#', trim, dedup
    case-insensitively keeping first-seen casing."""
    seen: dict[str, str] = {}
    for raw in tags:
        if not isinstance(raw, str):
            continue
        cleaned = raw.lstrip("#").strip()
        if not cleaned:
            continue
        key = cleaned.lower()
        if key not in seen:
            seen[key] = cleaned
    return list(seen.values())

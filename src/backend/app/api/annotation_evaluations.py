"""/api/annotations — V3 Phase 4 annotation evaluation + review status.

Annotation rows themselves live in the frontend zustand store; this
module persists only the user's review/evaluation data attached to those
annotations by string id. All routes scope by `doc_id` (and through it
the current project) so evaluations from another user/project never leak.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Doc, Project, User
from ..schemas import (
    EvaluationIn,
    EvaluationOut,
    EvaluationPatchIn,
    ReviewStateOut,
    ReviewStatusIn,
)
from ..models import Annotation
from ..schemas import (
    AnnotationIn,
    AnnotationOut,
    AnnotationPatchIn,
)
from ..services import annotation_service, evaluation_service
from ..services.event_bus import bus
from .deps import get_current_project, get_current_user


router = APIRouter(prefix="/api/annotations", tags=["annotation-evaluations"])


def _ensure_doc(db: Session, project: Project, doc_id: str) -> Doc:
    doc = db.get(Doc, doc_id)
    if doc is None or doc.project_id != project.id:
        raise HTTPException(404, "doc not found")
    return doc


def _to_out(row) -> EvaluationOut:
    return EvaluationOut(
        id=row.id,
        annotation_id=row.annotation_id,
        doc_id=row.doc_id,
        target_type=row.target_type,
        target_id=row.target_id,
        verdict=row.verdict,
        reason=row.reason,
        tags=row.tags or [],
        adoption=row.adoption,
        training_candidate=row.training_candidate,
        context=row.context or {},
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# ---------------------------------------------------------------------------
# Evaluation routes
# ---------------------------------------------------------------------------


@router.get("/by-doc/{doc_id}/evaluations", response_model=list[EvaluationOut])
def list_evaluations(
    doc_id: str,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[EvaluationOut]:
    _ensure_doc(db, project, doc_id)
    rows = evaluation_service.list_evaluations_by_doc(db, doc_id, user_id=user.id)
    return [_to_out(r) for r in rows]


@router.post(
    "/{annotation_id}/evaluations",
    response_model=EvaluationOut,
    status_code=201,
)
def create_evaluation(
    annotation_id: str,
    body: EvaluationIn,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> EvaluationOut:
    _ensure_doc(db, project, body.doc_id)
    if evaluation_service.get_evaluation(db, body.id) is not None:
        raise HTTPException(409, "evaluation id already exists")
    row = evaluation_service.create_evaluation(
        db,
        annotation_id=annotation_id,
        doc_id=body.doc_id,
        eid=body.id,
        target_type=body.target_type,
        target_id=body.target_id,
        verdict=body.verdict,
        reason=body.reason,
        tags=body.tags,
        adoption=body.adoption,
        training_candidate=body.training_candidate,
        context=body.context,
        user_id=user.id,
    )
    db.commit()
    out = _to_out(row)
    bus.publish(
        project.id,
        "annotation.evaluation.created",
        {"annotation_id": annotation_id, "doc_id": body.doc_id, "evaluation": out.model_dump(mode="json")},
        origin_client_id=x_client_id,
    )
    return out


@router.patch(
    "/{annotation_id}/evaluations/{evaluation_id}",
    response_model=EvaluationOut,
)
def patch_evaluation(
    annotation_id: str,
    evaluation_id: str,
    body: EvaluationPatchIn,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> EvaluationOut:
    row = evaluation_service.get_evaluation(db, evaluation_id)
    if row is None or row.annotation_id != annotation_id:
        raise HTTPException(404, "evaluation not found")
    if row.user_id and row.user_id != user.id:
        raise HTTPException(404, "evaluation not found")
    _ensure_doc(db, project, row.doc_id)
    row = evaluation_service.update_evaluation(
        db,
        row,
        verdict=body.verdict,
        reason=body.reason,
        tags=body.tags,
        adoption=body.adoption,
        training_candidate=body.training_candidate,
        context=body.context,
    )
    db.commit()
    out = _to_out(row)
    bus.publish(
        project.id,
        "annotation.evaluation.updated",
        {"annotation_id": annotation_id, "doc_id": row.doc_id, "evaluation": out.model_dump(mode="json")},
        origin_client_id=x_client_id,
    )
    return out


@router.delete(
    "/{annotation_id}/evaluations/{evaluation_id}",
    status_code=204,
)
def delete_evaluation(
    annotation_id: str,
    evaluation_id: str,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> None:
    row = evaluation_service.get_evaluation(db, evaluation_id)
    if row is None or row.annotation_id != annotation_id:
        raise HTTPException(404, "evaluation not found")
    if row.user_id and row.user_id != user.id:
        raise HTTPException(404, "evaluation not found")
    _ensure_doc(db, project, row.doc_id)
    doc_id = row.doc_id
    evaluation_service.delete_evaluation(db, row)
    db.commit()
    bus.publish(
        project.id,
        "annotation.evaluation.deleted",
        {"annotation_id": annotation_id, "doc_id": doc_id, "evaluation_id": evaluation_id},
        origin_client_id=x_client_id,
    )


# ---------------------------------------------------------------------------
# Review status routes
# ---------------------------------------------------------------------------


@router.patch("/{annotation_id}/review-status", response_model=ReviewStateOut)
def patch_review_status(
    annotation_id: str,
    body: ReviewStatusIn,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> ReviewStateOut:
    _ensure_doc(db, project, body.doc_id)
    row = evaluation_service.set_review_status(
        db,
        annotation_id=annotation_id,
        doc_id=body.doc_id,
        status=body.status,
        user_id=user.id,
    )
    db.commit()
    out = ReviewStateOut(
        annotation_id=row.annotation_id,
        doc_id=row.doc_id,
        status=row.status,
        updated_at=row.updated_at,
    )
    bus.publish(
        project.id,
        "annotation.review_status.changed",
        out.model_dump(mode="json"),
        origin_client_id=x_client_id,
    )
    return out


@router.get(
    "/by-doc/{doc_id}/review-states",
    response_model=list[ReviewStateOut],
)
def list_review_states(
    doc_id: str,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[ReviewStateOut]:
    _ensure_doc(db, project, doc_id)
    rows = evaluation_service.list_review_states_by_doc(db, doc_id, user_id=user.id)
    return [
        ReviewStateOut(
            annotation_id=r.annotation_id,
            doc_id=r.doc_id,
            status=r.status,
            updated_at=r.updated_at,
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Tag aggregate
# ---------------------------------------------------------------------------


@router.get(
    "/by-doc/{doc_id}/evaluation-tags",
    response_model=list[str],
)
def list_evaluation_tags(
    doc_id: str,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
) -> list[str]:
    _ensure_doc(db, project, doc_id)
    return evaluation_service.aggregate_tags_for_doc(db, doc_id)


# ---------------------------------------------------------------------------
# Annotation cards (V3 phase 2.5 — server-side source of truth)
# ---------------------------------------------------------------------------
#
# All operations broadcast over the project event bus. Optimistic clients
# tag their requests with X-Client-Id; the bus drops echoes for the
# originating browser to avoid double-applying local state.


def _ann_to_out(row: Annotation) -> AnnotationOut:
    return AnnotationOut.model_validate(row, from_attributes=True)


@router.get("/by-doc/{doc_id}/items", response_model=list[AnnotationOut])
def list_annotations(
    doc_id: str,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[AnnotationOut]:
    _ensure_doc(db, project, doc_id)
    rows = annotation_service.list_by_doc(db, doc_id, user_id=user.id)
    return [_ann_to_out(r) for r in rows]


@router.post("/items", response_model=AnnotationOut, status_code=201)
def create_annotation(
    body: AnnotationIn,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> AnnotationOut:
    _ensure_doc(db, project, body.doc_id)
    # No agent involved → global annotation (visible to all collaborators).
    # Has workflow_id or agent_name → private to the requesting user.
    is_global = not body.workflow_id and not body.agent_name
    row, created = annotation_service.upsert(
        db,
        annotation_id=body.id,
        doc_id=body.doc_id,
        project_id=project.id,
        user_id=user.id,
        is_global=is_global,
        kind=body.kind,
        status=body.status,
        range_from=body.range_from,
        range_to=body.range_to,
        target_text=body.target_text,
        content=body.content,
        severity=body.severity,
        workflow_id=body.workflow_id,
        agent_name=body.agent_name,
        conversation_id=body.conversation_id,
        original=body.original,
        proposed=body.proposed,
        reason=body.reason,
        risk_type=body.risk_type,
        mitigation=body.mitigation,
        thread=[m.model_dump(mode="json") for m in body.thread],
        attached_files=[f.model_dump(mode="json") for f in body.attached_files],
        created_at=body.created_at,
    )
    db.commit()
    bus.publish(
        project.id,
        "annotation.created" if created else "annotation.updated",
        {"annotation": annotation_service.to_dict(row)},
        origin_client_id=x_client_id,
    )
    return _ann_to_out(row)


@router.patch("/items/{annotation_id}", response_model=AnnotationOut)
def patch_annotation(
    annotation_id: str,
    body: AnnotationPatchIn,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> AnnotationOut:
    row = annotation_service.get(db, annotation_id)
    if row is None:
        raise HTTPException(404, "annotation not found")
    if row.user_id and row.user_id != user.id:
        raise HTTPException(404, "annotation not found")
    _ensure_doc(db, project, row.doc_id)
    annotation_service.patch(
        db,
        row,
        status=body.status,
        range_from=body.range_from,
        range_to=body.range_to,
        content=body.content,
        thread=([m.model_dump(mode="json") for m in body.thread] if body.thread is not None else None),
        publish=body.publish,
        acting_user_id=user.id,
    )
    db.commit()
    bus.publish(
        project.id,
        "annotation.updated",
        {"annotation": annotation_service.to_dict(row)},
        origin_client_id=x_client_id,
    )
    return _ann_to_out(row)


@router.delete("/items/{annotation_id}", status_code=204)
def delete_annotation(
    annotation_id: str,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> None:
    row = annotation_service.get(db, annotation_id)
    if row is None:
        return  # idempotent delete
    if row.user_id and row.user_id != user.id:
        return  # not yours
    _ensure_doc(db, project, row.doc_id)
    doc_id = row.doc_id
    annotation_service.delete(db, row)
    db.commit()
    bus.publish(
        project.id,
        "annotation.deleted",
        {"annotation_id": annotation_id, "doc_id": doc_id},
        origin_client_id=x_client_id,
    )

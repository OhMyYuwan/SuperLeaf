"""/api/annotations — V3 Phase 4 annotation evaluation + review status.

Annotation rows themselves live in the frontend zustand store; this
module persists only the user's review/evaluation data attached to those
annotations by string id. All routes scope by `doc_id` (and through it
the current project) so evaluations from another user/project never leak.
"""

from __future__ import annotations

import json
import re
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Annotation, Doc, Project, User, WorkflowDefinition
from ..schemas import (
    AnnotationAgentSuggestionOut,
    AnnotationAgentSuggestionPatchIn,
    AnnotationAgentSuggestionRunIn,
    AnnotationAgentSuggestionRunOut,
    AnnotationIn,
    AnnotationOut,
    AnnotationPatchIn,
    EvaluationIn,
    EvaluationOut,
    EvaluationPatchIn,
    ReviewStateOut,
    ReviewStatusIn,
)
from ..secrets_vault import decrypt
from ..services import annotation_agent_suggestion_service, annotation_service, evaluation_service
from ..services.agent_orchestrator import WorkflowOrchestrator
from ..services.agent_registry_service import NATIVE_WORKFLOW_PREFIX, AgentRegistryService
from ..services.event_bus import bus
from ..services.nanobot_client import NanobotClient
from ..services.project_member_service import ProjectMemberService
from .deps import get_current_project, get_current_user, require_write_access

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
    try:
        row = evaluation_service.set_review_status(
            db,
            annotation_id=annotation_id,
            doc_id=body.doc_id,
            status=body.status,
            user_id=user.id,
        )
    except evaluation_service.ReviewStateScopeError as exc:
        raise HTTPException(404, "review state not found") from exc
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
    user: User = Depends(get_current_user),
) -> list[str]:
    _ensure_doc(db, project, doc_id)
    return evaluation_service.aggregate_tags_for_doc(db, doc_id, user_id=user.id)


# ---------------------------------------------------------------------------
# Annotation cards (V3 phase 2.5 — server-side source of truth)
# ---------------------------------------------------------------------------
#
# All operations broadcast over the project event bus. Optimistic clients
# tag their requests with X-Client-Id; the bus drops echoes for the
# originating browser to avoid double-applying local state.


def _ann_to_out(row: Annotation) -> AnnotationOut:
    return AnnotationOut.model_validate(row, from_attributes=True)


def _suggestion_to_out(row) -> AnnotationAgentSuggestionOut:
    return AnnotationAgentSuggestionOut.model_validate(row, from_attributes=True)


def _annotation_patch_touches_source(body: AnnotationPatchIn) -> bool:
    touched = body.model_fields_set
    if not touched:
        return False
    # Visibility-only publishing is not a semantic annotation change. Range-only
    # drift is also ignored so collaborators can keep highlights aligned without
    # invalidating private Agent suggestions.
    return bool(touched & {"status", "content", "thread"})


def _json_ready(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {str(key): _json_ready(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_ready(item) for item in value]
    return value


_RANGE_PATCH_FIELDS = {"range_from", "range_to"}


def _is_range_only_patch(body: AnnotationPatchIn) -> bool:
    touched = body.model_fields_set
    return bool(touched) and touched <= _RANGE_PATCH_FIELDS


def _annotation_patch_requires_project_write(row: Annotation, body: AnnotationPatchIn) -> bool:
    return row.is_global or body.publish is not None


def _ensure_annotation_patch_allowed(
    db: Session,
    project: Project,
    row: Annotation,
    user: User,
    body: AnnotationPatchIn,
) -> None:
    if row.user_id == user.id:
        if _annotation_patch_requires_project_write(row, body) and not ProjectMemberService(db).can_write(
            project.id, user.id
        ):
            raise HTTPException(403, "Read-only access")
        return
    if row.is_global and _is_range_only_patch(body):
        if ProjectMemberService(db).can_write(project.id, user.id):
            return
        raise HTTPException(403, "Read-only access")
    raise HTTPException(404, "annotation not found")


def _ensure_annotation_upsert_allowed(
    db: Session,
    project: Project,
    row: Annotation,
    user: User,
    body: AnnotationIn,
) -> None:
    _ensure_doc(db, project, row.doc_id)
    if row.project_id != project.id or row.doc_id != body.doc_id:
        raise HTTPException(404, "annotation not found")
    if row.user_id == user.id:
        return
    if row.is_global and ProjectMemberService(db).can_write(project.id, user.id):
        return
    raise HTTPException(404, "annotation not found")


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
    project: Project = Depends(require_write_access),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> AnnotationOut:
    _ensure_doc(db, project, body.doc_id)
    existing = annotation_service.get(db, body.id)
    if existing is not None:
        _ensure_annotation_upsert_allowed(db, project, existing, user, body)
    old_source_hash = (
        annotation_agent_suggestion_service.compute_annotation_source_hash(existing)
        if existing is not None
        else ""
    )
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
        thread=[_json_ready(m) for m in body.thread],
        attached_files=[_json_ready(f) for f in body.attached_files],
        created_at=body.created_at,
    )
    if not created and old_source_hash:
        new_source_hash = annotation_agent_suggestion_service.compute_annotation_source_hash(row)
        if old_source_hash != new_source_hash:
            annotation_agent_suggestion_service.mark_stale_for_annotation(db, row)
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
    _ensure_doc(db, project, row.doc_id)
    _ensure_annotation_patch_allowed(db, project, row, user, body)
    old_source_hash = annotation_agent_suggestion_service.compute_annotation_source_hash(row)
    annotation_service.patch(
        db,
        row,
        status=body.status,
        range_from=body.range_from,
        range_to=body.range_to,
        content=body.content,
        thread=([_json_ready(m) for m in body.thread] if body.thread is not None else None),
        publish=body.publish,
        acting_user_id=user.id,
    )
    if _annotation_patch_touches_source(body):
        new_source_hash = annotation_agent_suggestion_service.compute_annotation_source_hash(row)
        if old_source_hash != new_source_hash:
            annotation_agent_suggestion_service.mark_stale_for_annotation(db, row)
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
    if row.is_global and not ProjectMemberService(db).can_write(project.id, user.id):
        raise HTTPException(403, "Read-only access")
    doc_id = row.doc_id
    annotation_service.delete(db, row)
    db.commit()
    bus.publish(
        project.id,
        "annotation.deleted",
        {"annotation_id": annotation_id, "doc_id": doc_id},
        origin_client_id=x_client_id,
    )


# ---------------------------------------------------------------------------
# Private Agent suggestions for annotation auto-reply
# ---------------------------------------------------------------------------


@router.get(
    "/agent-suggestions/by-doc/{doc_id}",
    response_model=list[AnnotationAgentSuggestionOut],
)
def list_agent_suggestions(
    doc_id: str,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[AnnotationAgentSuggestionOut]:
    _ensure_doc(db, project, doc_id)
    rows = annotation_agent_suggestion_service.list_by_doc(db, doc_id, user_id=user.id)
    return [_suggestion_to_out(row) for row in rows]


@router.post(
    "/agent-suggestions/run",
    response_model=AnnotationAgentSuggestionRunOut,
)
async def run_agent_suggestions(
    body: AnnotationAgentSuggestionRunIn,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> AnnotationAgentSuggestionRunOut:
    doc = _ensure_doc(db, project, body.doc_id)
    target_kind = body.target_kind or "agent"
    workflow_id = body.agent_id
    resolved = None
    provider = None
    workflow_def = None
    if target_kind == "workflow":
        workflow_def = db.get(WorkflowDefinition, body.agent_id)
        if (
            workflow_def is None
            or workflow_def.project_id != project.id
            or workflow_def.user_id != user.id
            or not workflow_def.is_active
        ):
            raise HTTPException(404, "workflow definition not found")
    else:
        workflow_id = _canonical_native_agent_id(body.agent_id)
        resolved = AgentRegistryService(db).resolve(
            workflow_id,
            project_id=project.id,
            user_id=user.id,
            require_enabled=True,
        )
        if resolved is None or resolved.native_agent is None:
            raise HTTPException(404, "native agent not found")
        provider = resolved.provider
        if provider.kind != "native":
            raise HTTPException(400, "auto-reply currently supports native agents only")

    annotations = [
        row
        for row in annotation_service.list_by_doc(db, doc.id, user_id=user.id)
        if row.status not in annotation_agent_suggestion_service.TERMINAL_ANNOTATION_STATUSES
    ]
    existing = annotation_agent_suggestion_service.existing_for_annotations(
        db,
        annotation_ids=[row.id for row in annotations],
        user_id=user.id,
        agent_id=workflow_id,
    )

    processed = 0
    skipped = 0
    failed = 0
    out_rows = []
    for annotation in annotations:
        source_hash = annotation_agent_suggestion_service.compute_annotation_source_hash(annotation)
        current = existing.get(annotation.id)
        if not annotation_agent_suggestion_service.should_process_annotation(
            annotation,
            current,
            source_hash=source_hash,
            include_stale=body.include_stale,
        ):
            skipped += 1
            continue
        try:
            if target_kind == "workflow":
                if workflow_def is None:
                    raise ValueError("workflow definition unavailable")
                suggestions, meta = await _generate_annotation_auto_reply_workflow(
                    db=db,
                    workflow_def=workflow_def,
                    project=project,
                    user=user,
                    doc=doc,
                    annotation=annotation,
                )
            else:
                if provider is None or resolved is None or resolved.native_agent is None:
                    raise ValueError("native agent unavailable")
                suggestions, meta = await _generate_annotation_auto_reply(
                    provider_endpoint=provider.endpoint,
                    api_key=decrypt(provider.api_key_enc) if provider.api_key_enc else "",
                    model=resolved.native_agent.model,
                    agent_name=resolved.native_agent.name,
                    agent_instructions=resolved.native_agent.instructions,
                    doc=doc,
                    annotation=annotation,
                )
            row = annotation_agent_suggestion_service.upsert_generated(
                db,
                project_id=project.id,
                doc_id=doc.id,
                annotation_id=annotation.id,
                user_id=user.id,
                agent_id=workflow_id,
                source_hash=source_hash,
                suggestions=suggestions,
                internal_meta=meta,
                status="drafted",
            )
            processed += 1
        except Exception as exc:  # noqa: BLE001
            row = annotation_agent_suggestion_service.upsert_generated(
                db,
                project_id=project.id,
                doc_id=doc.id,
                annotation_id=annotation.id,
                user_id=user.id,
                agent_id=workflow_id,
                source_hash=source_hash,
                suggestions=[],
                internal_meta={"error_type": type(exc).__name__},
                error=f"{type(exc).__name__}: {exc}"[:1000],
                status="failed",
            )
            failed += 1
        db.commit()
        db.refresh(row)
        out_rows.append(row)

    return AnnotationAgentSuggestionRunOut(
        processed=processed,
        skipped=skipped,
        failed=failed,
        suggestions=[_suggestion_to_out(row) for row in out_rows],
    )


@router.patch(
    "/agent-suggestions/{suggestion_id}",
    response_model=AnnotationAgentSuggestionOut,
)
def patch_agent_suggestion(
    suggestion_id: str,
    body: AnnotationAgentSuggestionPatchIn,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> AnnotationAgentSuggestionOut:
    row = annotation_agent_suggestion_service.get_for_user(db, suggestion_id, user_id=user.id)
    if row is None or row.project_id != project.id:
        raise HTTPException(404, "agent suggestion not found")
    annotation_agent_suggestion_service.patch_for_user(
        db,
        row,
        status=body.status,
        suggestions=body.suggestions,
    )
    db.commit()
    db.refresh(row)
    return _suggestion_to_out(row)


@router.delete("/agent-suggestions/{suggestion_id}", status_code=204)
def delete_agent_suggestion(
    suggestion_id: str,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    row = annotation_agent_suggestion_service.get_for_user(db, suggestion_id, user_id=user.id)
    if row is None or row.project_id != project.id:
        return
    annotation_agent_suggestion_service.delete(db, row)
    db.commit()


def _canonical_native_agent_id(value: str) -> str:
    raw = str(value or "").strip()
    if raw.startswith(NATIVE_WORKFLOW_PREFIX):
        return raw
    return f"{NATIVE_WORKFLOW_PREFIX}{raw}"


async def _generate_annotation_auto_reply(
    *,
    provider_endpoint: str,
    api_key: str,
    model: str,
    agent_name: str,
    agent_instructions: str,
    doc: Doc,
    annotation: Annotation,
) -> tuple[list[str], dict]:
    client = NanobotClient(endpoint=provider_endpoint, api_key=api_key, timeout=30.0)
    system_prompt = _annotation_auto_reply_system_prompt(
        agent_name=agent_name,
        agent_instructions=agent_instructions,
    )
    user_prompt = _annotation_auto_reply_user_prompt(doc, annotation)
    parts: list[str] = []
    async for evt in client.run_streaming(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.2,
        max_tokens=800,
    ):
        delta = _nanobot_delta_text(evt)
        if delta:
            parts.append(delta)
    raw = "".join(parts).strip()
    suggestions = _parse_auto_reply_suggestions(raw)
    if not suggestions:
        raise ValueError("agent returned no suggestions")
    return suggestions, {
        "mode": "annotation_auto_reply",
        "agent_name": agent_name,
        "raw_preview": raw[:1000],
        "prompt_version": 1,
    }


async def _generate_annotation_auto_reply_workflow(
    *,
    db: Session,
    workflow_def: WorkflowDefinition,
    project: Project,
    user: User,
    doc: Doc,
    annotation: Annotation,
) -> tuple[list[str], dict]:
    prompt = "\n\n".join([
        _annotation_auto_reply_system_prompt(
            agent_name=workflow_def.name,
            agent_instructions=workflow_def.description or "",
        ),
        _annotation_auto_reply_user_prompt(doc, annotation),
    ])
    final_outputs: Any = None
    async for event in WorkflowOrchestrator(db).execute_workflow(
        workflow_def_id=workflow_def.id,
        project_id=project.id,
        user_id=user.id,
        document_id=doc.id,
        target_text=annotation.target_text or annotation.content or "",
        range_start=int(annotation.range_from or 0),
        range_end=int(annotation.range_to or annotation.range_from or 0),
        user_instruction=prompt,
        context_files=[],
    ):
        if event.get("event") == "workflow.completed":
            data = event.get("data") if isinstance(event.get("data"), dict) else {}
            final_outputs = data.get("outputs")
    raw = _workflow_outputs_text(final_outputs)
    suggestions = _parse_auto_reply_suggestions(raw)
    if not suggestions:
        raise ValueError("workflow returned no suggestions")
    return suggestions, {
        "mode": "annotation_auto_reply_workflow",
        "workflow_definition_id": workflow_def.id,
        "workflow_definition_name": workflow_def.name,
        "raw_preview": raw[:1000],
        "prompt_version": 1,
    }


def _workflow_outputs_text(outputs: Any) -> str:
    if isinstance(outputs, str):
        return outputs
    if isinstance(outputs, dict):
        suggestions = outputs.get("suggestions")
        if isinstance(suggestions, list):
            return json.dumps({"suggestions": suggestions}, ensure_ascii=False)
        for key in ("text", "answer", "result", "output"):
            value = outputs.get(key)
            if isinstance(value, str):
                return value
        nested = outputs.get("outputs")
        if isinstance(nested, dict):
            nested_text = _workflow_outputs_text(nested)
            if nested_text:
                return nested_text
        return json.dumps(outputs, ensure_ascii=False)
    if isinstance(outputs, list):
        return "\n".join(_workflow_outputs_text(item) for item in outputs)
    return str(outputs or "")


def _annotation_auto_reply_system_prompt(*, agent_name: str, agent_instructions: str) -> str:
    parts = [
        "You are a SuperLeaf annotation auto-reply assistant.",
        "Your task is to help the current user pre-process visible document annotations.",
        "Do not modify documents.",
        "Do not create annotation cards.",
        "Do not send a reply to collaborators.",
        "Do not reveal analysis, classification, confidence, source hashes, or context notes.",
        "Return only compact JSON with a suggestions array of 2-3 concise, actionable strings.",
        "Each suggestion should be one or two sentences and directly useful to the user.",
        'Required schema: {"suggestions":["...","..."]}',
    ]
    if agent_name:
        parts.append(f"Agent name: {agent_name}")
    if agent_instructions.strip():
        parts.extend(["Agent instructions:", agent_instructions.strip()])
    return "\n".join(parts)


def _annotation_auto_reply_user_prompt(doc: Doc, annotation: Annotation) -> str:
    before, target, after = _annotation_surrounding_context(doc.content or "", annotation)
    thread_text = _annotation_thread_text(annotation.thread or [])
    return "\n\n".join(
        part
        for part in [
            f"Document: {doc.name} ({doc.format})",
            f"Annotation kind: {annotation.kind}",
            f"Annotation content:\n{annotation.content or ''}",
            f"Annotated text:\n{annotation.target_text or target}",
            f"Thread:\n{thread_text}" if thread_text else "",
            f"Before context:\n{before}" if before else "",
            f"After context:\n{after}" if after else "",
            (
                "Return JSON only. Generate 2-3 private suggestions for how the "
                "current user can handle this annotation."
            ),
        ]
        if part
    )


def _annotation_surrounding_context(doc_content: str, annotation: Annotation) -> tuple[str, str, str]:
    total = len(doc_content)
    start = max(0, min(int(annotation.range_from or 0), total))
    end = max(start, min(int(annotation.range_to or 0), total))
    before = doc_content[max(0, start - 800):start].strip()
    target = doc_content[start:end].strip()
    after = doc_content[end:min(total, end + 800)].strip()
    return before, target, after


def _annotation_thread_text(thread: list) -> str:
    lines: list[str] = []
    for item in thread:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "user")
        name = str(item.get("agent_name") or ("Agent" if role == "agent" else "User"))
        content = str(item.get("content") or "").strip()
        if content:
            lines.append(f"{name}: {content}")
    return "\n".join(lines)


def _nanobot_delta_text(evt: dict[str, Any]) -> str:
    choices = evt.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if isinstance(delta, dict) and isinstance(delta.get("content"), str):
        return delta["content"]
    message = first.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return message["content"]
    return ""


def _parse_auto_reply_suggestions(raw: str) -> list[str]:
    text = _strip_code_fence(raw.strip())
    candidates = [text]
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        candidates.append(match.group(0))
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        values = data.get("suggestions") if isinstance(data, dict) else None
        if isinstance(values, list):
            cleaned = _clean_suggestion_strings(values)
            if cleaned:
                return cleaned
    return _clean_suggestion_strings(_fallback_suggestion_lines(text))


def _strip_code_fence(text: str) -> str:
    match = re.match(r"^```(?:json)?\s*([\s\S]*?)\s*```$", text.strip(), re.I)
    return match.group(1).strip() if match else text


def _fallback_suggestion_lines(text: str) -> list[str]:
    lines: list[str] = []
    for line in text.splitlines():
        item = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip()
        if item:
            lines.append(item)
    return lines


def _clean_suggestion_strings(values: list[Any]) -> list[str]:
    out: list[str] = []
    for value in values:
        item = str(value or "").strip()
        if not item:
            continue
        out.append(item[:1000])
        if len(out) >= 3:
            break
    return out

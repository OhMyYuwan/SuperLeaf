"""/api/datasets — Data Project source rules, records, labels, and exports."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import DatasetProject, DatasetRecord, DatasetResponse, Project, User
from ..schemas import (
    DatasetBatchOut,
    DatasetFilterOptionsOut,
    DatasetProjectOut,
    DatasetProjectPatch,
    DatasetRecordListOut,
    DatasetRecordOut,
    DatasetResponseIn,
    DatasetResponseOut,
    DatasetSourceRuleIn,
    DatasetSourceRuleOut,
    DatasetSourceRulePatch,
    DatasetSyncOut,
)
from ..services.dataset_service import DatasetService
from .deps import get_current_project, get_current_user, require_write_access

router = APIRouter(prefix="/api/datasets", tags=["datasets"])

CurrentProject = Depends(get_current_project)
CurrentUser = Depends(get_current_user)
DbSession = Depends(get_session)
WriteProject = Depends(require_write_access)


def _dataset_for_project(
    db: Session,
    project: Project,
    *,
    user_id: str,
) -> DatasetProject:
    try:
        return DatasetService(db).ensure_dataset_project(project, user_id=user_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def _record_out(row: DatasetRecord, response: DatasetResponse | None = None) -> DatasetRecordOut:
    out = DatasetRecordOut.model_validate(row)
    if response is not None:
        out.my_response = DatasetResponseOut.model_validate(response)
    return out


@router.get("/current", response_model=DatasetProjectOut)
def get_current_dataset_project(
    project: Project = CurrentProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetProjectOut:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    return DatasetProjectOut.model_validate(dataset)


@router.patch("/current", response_model=DatasetProjectOut)
def update_current_dataset_project(
    body: DatasetProjectPatch,
    project: Project = WriteProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetProjectOut:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    row = DatasetService(db).update_dataset_project(
        dataset,
        name=body.name,
        guidelines=body.guidelines,
        label_schema=body.label_schema,
    )
    return DatasetProjectOut.model_validate(row)


@router.get("/current/filter-options", response_model=DatasetFilterOptionsOut)
def list_current_filter_options(
    source_project_id: str = Query(min_length=1, max_length=64),
    project: Project = CurrentProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetFilterOptionsOut:
    _dataset_for_project(db, project, user_id=user.id)
    try:
        options = DatasetService(db).source_filter_options(source_project_id, user_id=user.id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return DatasetFilterOptionsOut(**options)


@router.get("/current/source-rules", response_model=list[DatasetSourceRuleOut])
def list_current_source_rules(
    project: Project = CurrentProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> list[DatasetSourceRuleOut]:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    rows = DatasetService(db).list_source_rules(dataset)
    return [DatasetSourceRuleOut.model_validate(row) for row in rows]


@router.post("/current/source-rules", response_model=DatasetSourceRuleOut, status_code=201)
def create_current_source_rule(
    body: DatasetSourceRuleIn,
    project: Project = WriteProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetSourceRuleOut:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    try:
        row = DatasetService(db).create_source_rule(
            dataset,
            source_project_id=body.source_project_id,
            user_id=user.id,
            name=body.name,
            source_types=body.source_types,
            filters=body.filters,
            is_enabled=body.is_enabled,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return DatasetSourceRuleOut.model_validate(row)


@router.patch("/source-rules/{rule_id}", response_model=DatasetSourceRuleOut)
def update_source_rule(
    rule_id: str,
    body: DatasetSourceRulePatch,
    project: Project = WriteProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetSourceRuleOut:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    svc = DatasetService(db)
    rule = svc.get_source_rule(dataset, rule_id)
    if rule is None:
        raise HTTPException(404, "Source rule not found")
    try:
        row = svc.update_source_rule(
            rule,
            user_id=user.id,
            name=body.name,
            source_types=body.source_types,
            filters=body.filters,
            is_enabled=body.is_enabled,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return DatasetSourceRuleOut.model_validate(row)


@router.post("/source-rules/{rule_id}/sync", response_model=DatasetSyncOut)
def sync_source_rule(
    rule_id: str,
    project: Project = WriteProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetSyncOut:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    svc = DatasetService(db)
    rule = svc.get_source_rule(dataset, rule_id)
    if rule is None:
        raise HTTPException(404, "Source rule not found")
    try:
        batch, created, skipped, scanned = svc.sync_source_rule(dataset, rule, user=user)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return DatasetSyncOut(
        batch=DatasetBatchOut.model_validate(batch),
        created=created,
        skipped=skipped,
        scanned=scanned,
    )


@router.get("/current/records", response_model=DatasetRecordListOut)
def list_current_records(
    status: str = Query(default="all"),
    source_type: str = Query(default="all"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    project: Project = CurrentProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetRecordListOut:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    svc = DatasetService(db)
    rows, total = svc.list_records(
        dataset,
        status=status,
        source_type=source_type,
        limit=limit,
        offset=offset,
    )
    responses = svc.responses_for_records(rows, user_id=user.id)
    return DatasetRecordListOut(
        records=[_record_out(row, responses.get(row.id)) for row in rows],
        total=total,
    )


@router.get("/records/{record_id}", response_model=DatasetRecordOut)
def get_record(
    record_id: str,
    project: Project = CurrentProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetRecordOut:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    svc = DatasetService(db)
    row = svc.get_record(dataset, record_id)
    if row is None:
        raise HTTPException(404, "Record not found")
    return _record_out(row, svc.response_for_record(row, user_id=user.id))


@router.patch("/records/{record_id}/response/me", response_model=DatasetResponseOut)
def save_my_response(
    record_id: str,
    body: DatasetResponseIn,
    project: Project = WriteProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetResponseOut:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    svc = DatasetService(db)
    record = svc.get_record(dataset, record_id)
    if record is None:
        raise HTTPException(404, "Record not found")
    try:
        response = svc.save_response(
            record,
            user_id=user.id,
            values=body.values,
            status=body.status,
            lead_time_ms=body.lead_time_ms,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return DatasetResponseOut.model_validate(response)


@router.post("/records/{record_id}/response/me/submit", response_model=DatasetResponseOut)
def submit_my_response(
    record_id: str,
    body: DatasetResponseIn,
    project: Project = WriteProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetResponseOut:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    svc = DatasetService(db)
    record = svc.get_record(dataset, record_id)
    if record is None:
        raise HTTPException(404, "Record not found")
    response = svc.save_response(
        record,
        user_id=user.id,
        values=body.values,
        status="submitted",
        lead_time_ms=body.lead_time_ms,
    )
    return DatasetResponseOut.model_validate(response)


@router.post("/records/{record_id}/discard", response_model=DatasetResponseOut)
def discard_record(
    record_id: str,
    project: Project = WriteProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> DatasetResponseOut:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    svc = DatasetService(db)
    record = svc.get_record(dataset, record_id)
    if record is None:
        raise HTTPException(404, "Record not found")
    response = svc.discard_record(record, user_id=user.id)
    return DatasetResponseOut.model_validate(response)


@router.get("/current/export.zip")
def export_current_dataset(
    status: str = Query(
        default="submitted",
        pattern="^(submitted|all|pending|in_review|labeled|discarded)$",
    ),
    project: Project = CurrentProject,
    user: User = CurrentUser,
    db: Session = DbSession,
) -> Response:
    dataset = _dataset_for_project(db, project, user_id=user.id)
    data = DatasetService(db).export_zip(dataset, user=user, status=status)
    safe_name = "".join(
        ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in dataset.name
    ).strip("-")
    filename = f"{safe_name or 'dataset'}-export.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

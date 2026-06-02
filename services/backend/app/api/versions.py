"""/api/docs/{doc_id}/versions — V3 Phase 3 history & diff routes.

Three-table storage (blobs / document_versions / document_labels) lives in
`services/version_service.py`; the Overleaf-shaped diff comes from
`services/diff_service.py`. This module only stitches HTTP onto the services.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Blob, Doc, DocumentLabel, DocumentVersion, Project
from ..schemas import DiffOut, DocOut, LabelIn, LabelOut, OperationIn, OperationOut, VersionOut
from ..services import operation_service, version_service
from ..services.diff_service import compute_diff
from ..services.project_fs_service import ProjectFsService
from .deps import get_current_project

router = APIRouter(prefix="/api/docs", tags=["versions"])


def _ensure_doc(db: Session, project: Project, doc_id: str) -> Doc:
    doc = db.get(Doc, doc_id)
    if doc is None or doc.project_id != project.id:
        raise HTTPException(404, "doc not found")
    return doc


def _labels_for(db: Session, doc_id: str) -> dict[int, list[LabelOut]]:
    rows = (
        db.query(DocumentLabel)
        .filter(DocumentLabel.doc_id == doc_id)
        .all()
    )
    by_version: dict[int, list[LabelOut]] = {}
    for r in rows:
        by_version.setdefault(r.version, []).append(LabelOut.model_validate(r))
    return by_version


def _version_to_out(
    v: DocumentVersion,
    blob: Blob,
    labels: list[LabelOut],
    *,
    include_content: bool = False,
) -> VersionOut:
    binary = blob.string_length is None
    content: str | None = None
    if include_content and not binary:
        try:
            content = blob.content.decode("utf-8")
        except UnicodeDecodeError:
            binary = True
            content = None
    return VersionOut(
        id=v.id,
        version=v.version,
        blob_hash=v.blob_hash,
        created_at=v.created_at,
        origin=v.origin,
        actor=v.actor,
        byte_length=blob.byte_length,
        string_length=blob.string_length,
        labels=labels,
        content=content,
        binary=binary,
    )


def _current_doc_blob(doc: Doc) -> Blob:
    content = (doc.content or "").encode("utf-8")
    return Blob(
        hash="current",
        content=content,
        byte_length=len(content),
        string_length=len(doc.content or ""),
        created_at=doc.updated_at or datetime.utcnow(),
    )


@router.get("/{doc_id}/versions", response_model=list[VersionOut])
def list_versions(
    doc_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> list[VersionOut]:
    _ensure_doc(db, project, doc_id)
    versions = version_service.list_versions(db, doc_id)
    if not versions:
        return []
    blobs = {
        b.hash: b
        for b in db.query(Blob)
        .filter(Blob.hash.in_({v.blob_hash for v in versions}))
        .all()
    }
    labels_by_version = _labels_for(db, doc_id)
    return [
        _version_to_out(
            v,
            blobs[v.blob_hash],
            labels_by_version.get(v.version, []),
        )
        for v in versions
        if v.blob_hash in blobs
    ]


@router.get("/{doc_id}/versions/{version}", response_model=VersionOut)
def get_version(
    doc_id: str,
    version: int,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> VersionOut:
    _ensure_doc(db, project, doc_id)
    v = version_service.get_version(db, doc_id, version)
    if v is None:
        raise HTTPException(404, "version not found")
    blob = db.get(Blob, v.blob_hash)
    if blob is None:
        raise HTTPException(500, "blob missing for version")
    labels = _labels_for(db, doc_id).get(version, [])
    return _version_to_out(v, blob, labels, include_content=True)


@router.get("/{doc_id}/diff", response_model=DiffOut)
def get_diff(
    doc_id: str,
    from_: int = Query(..., alias="from", ge=1),
    to: str = Query(...),
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> DiffOut:
    doc = _ensure_doc(db, project, doc_id)

    va = version_service.get_version(db, doc_id, from_)
    if va is None:
        raise HTTPException(404, "version not found")

    blob_a = db.get(Blob, va.blob_hash)
    if blob_a is None:
        raise HTTPException(500, "blob missing for version")

    if to == "current":
        blob_b = _current_doc_blob(doc)
        return DiffOut(diff=compute_diff(blob_a, blob_b))

    try:
        to_version = int(to)
    except ValueError as e:
        raise HTTPException(400, "to must be a version number or 'current'") from e
    if to_version < 1:
        raise HTTPException(400, "to must be greater than or equal to 1")
    if from_ == to_version:
        raise HTTPException(400, "from and to must differ")

    a, b = (from_, to_version) if from_ < to_version else (to_version, from_)
    va = version_service.get_version(db, doc_id, a)
    vb = version_service.get_version(db, doc_id, b)
    if va is None or vb is None:
        raise HTTPException(404, "version not found")

    blob_a = db.get(Blob, va.blob_hash)
    blob_b = db.get(Blob, vb.blob_hash)
    if blob_a is None or blob_b is None:
        raise HTTPException(500, "blob missing for version")
    return DiffOut(diff=compute_diff(blob_a, blob_b))


@router.post("/{doc_id}/restore/{version}", response_model=DocOut)
def restore_version(
    doc_id: str,
    version: int,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> DocOut:
    """Restore is append-only: it applies the historical content as the new
    head and records a fresh `origin='restore'` snapshot. The original
    historical version is preserved unchanged.
    """
    _ensure_doc(db, project, doc_id)
    v = version_service.get_version(db, doc_id, version)
    if v is None:
        raise HTTPException(404, "version not found")
    blob = db.get(Blob, v.blob_hash)
    if blob is None:
        raise HTTPException(500, "blob missing for version")
    if blob.string_length is None:
        raise HTTPException(400, "cannot restore a binary version into a text doc")

    text = blob.content.decode("utf-8")
    actor = str(project.user_id) if project.user_id else None
    svc = ProjectFsService(db, project)
    doc = svc.update_doc_content(
        doc_id,
        text,
        origin="restore",
        actor=actor,
    )
    if doc is None:
        raise HTTPException(404, "doc not found")

    operation_service.record(
        db,
        doc_id,
        "restore",
        payload={"version": version, "byte_length": blob.byte_length},
        actor=actor,
    )
    db.commit()

    return DocOut.model_validate(doc)


@router.post("/{doc_id}/labels", response_model=LabelOut, status_code=201)
def add_label(
    doc_id: str,
    body: LabelIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> LabelOut:
    _ensure_doc(db, project, doc_id)
    try:
        label = version_service.add_label(db, doc_id, body.version, body.text)
    except ValueError as e:
        raise HTTPException(404, str(e))
    operation_service.record(
        db,
        doc_id,
        "label_add",
        payload={"version": body.version, "label_id": label.id, "text": body.text},
        actor=str(project.user_id) if project.user_id else None,
    )
    db.commit()
    return LabelOut.model_validate(label)


@router.delete("/{doc_id}/labels/{label_id}", status_code=204)
def remove_label(
    doc_id: str,
    label_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> None:
    _ensure_doc(db, project, doc_id)
    label = db.get(DocumentLabel, label_id)
    payload = (
        {"version": label.version, "label_id": label.id, "text": label.text}
        if label is not None
        else {"label_id": label_id}
    )
    if not version_service.remove_label(db, doc_id, label_id):
        raise HTTPException(404, "label not found")
    operation_service.record(
        db,
        doc_id,
        "label_remove",
        payload=payload,
        actor=str(project.user_id) if project.user_id else None,
    )
    db.commit()


# ---------------------------------------------------------------------------
# Operation audit log (3.3)
# ---------------------------------------------------------------------------


@router.get("/{doc_id}/operations", response_model=list[OperationOut])
def list_operations(
    doc_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> list[OperationOut]:
    _ensure_doc(db, project, doc_id)
    rows = operation_service.list_for_doc(db, doc_id, limit=limit, offset=offset)
    return [OperationOut.model_validate(r) for r in rows]


@router.post("/{doc_id}/operations", response_model=OperationOut, status_code=201)
def create_operation(
    doc_id: str,
    body: OperationIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> OperationOut:
    """Frontend-driven entry point.

    Only `accept_suggestion` / `reject_suggestion` are expected here in
    practice — the other op types are recorded server-side alongside the
    underlying mutation. We still accept all five for symmetry/testability.
    """
    _ensure_doc(db, project, doc_id)
    try:
        row = operation_service.record(
            db,
            doc_id,
            body.type,
            payload=body.payload,
            actor=str(project.user_id) if project.user_id else None,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.commit()
    return OperationOut.model_validate(row)

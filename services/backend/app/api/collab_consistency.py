"""Helpers that keep DB-only project operations consistent with Yjs state."""

from __future__ import annotations

import asyncio

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Doc, Project
from ..services import collab_snapshot_service
from ..services.collab_audit_log import record_collab_event
from ..services.collab_gateway import CollabGateway, CollabGatewayError
from ..services.collab_snapshot_service import CollabSnapshotError


async def flush_project_collab_or_503(project: Project) -> list[str]:
    try:
        flushed_doc_ids = await collab_snapshot_service.snapshot_project_from_collab(project.id)
        record_collab_event(
            "project_flush_succeeded",
            project_id=project.id,
            operation="project_flush",
            details={"flushed_doc_ids": flushed_doc_ids, "count": len(flushed_doc_ids)},
        )
        return flushed_doc_ids
    except CollabSnapshotError as exc:
        record_collab_event(
            "project_flush_failed",
            level="error",
            project_id=project.id,
            operation="project_flush",
            code="collab_flush_failed",
            message=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "collab_flush_failed",
                "message": "Unable to flush active collaboration state",
            },
        ) from exc


def flush_project_collab_or_503_sync(project: Project) -> list[str]:
    return asyncio.run(flush_project_collab_or_503(project))


async def sync_collab_doc_from_db_or_503(
    db: Session,
    project: Project,
    doc_id: str,
    *,
    operation: str,
) -> dict:
    doc = db.get(Doc, doc_id)
    if doc is None or doc.project_id != project.id:
        raise HTTPException(404, "doc not found")

    gateway = CollabGateway()
    try:
        result = await gateway.replace_doc_text(
            doc.id,
            doc.content or "",
            collab_generation=doc.collab_generation,
        )
    except CollabGatewayError as exc:
        record_collab_event(
            "collab_doc_replace_failed",
            level="error",
            project_id=project.id,
            doc_id=doc.id,
            operation=operation,
            code="collab_replace_failed",
            message=str(exc),
            details={"version": doc.version, "collab_generation": doc.collab_generation},
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "collab_replace_failed",
                "message": "Unable to synchronize the collaboration room with database state",
            },
        ) from exc

    record_collab_event(
        "collab_doc_replace_succeeded",
        project_id=project.id,
        doc_id=doc.id,
        operation=operation,
        details={"version": doc.version, "collab_generation": doc.collab_generation, **result},
    )
    return result


async def sync_project_collab_from_db_or_503(
    db: Session,
    project: Project,
    *,
    operation: str,
) -> list[str]:
    rows = (
        db.query(Doc)
        .filter(Doc.project_id == project.id)
        .order_by(Doc.id.asc())
        .all()
    )
    synced_doc_ids: list[str] = []
    gateway = CollabGateway()
    for doc in rows:
        try:
            result = await gateway.replace_doc_text(
                doc.id,
                doc.content or "",
                collab_generation=doc.collab_generation,
            )
        except CollabGatewayError as exc:
            record_collab_event(
                "collab_project_replace_failed",
                level="error",
                project_id=project.id,
                doc_id=doc.id,
                operation=operation,
                code="collab_replace_failed",
                message=str(exc),
                details={
                    "synced_doc_ids": synced_doc_ids,
                    "version": doc.version,
                    "collab_generation": doc.collab_generation,
                },
            )
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "collab_replace_failed",
                    "message": "Unable to synchronize the collaboration rooms with database state",
                },
            ) from exc
        synced_doc_ids.append(doc.id)
        record_collab_event(
            "collab_doc_replace_succeeded",
            project_id=project.id,
            doc_id=doc.id,
            operation=operation,
            details={"version": doc.version, "collab_generation": doc.collab_generation, **result},
        )

    record_collab_event(
        "collab_project_replace_succeeded",
        project_id=project.id,
        operation=operation,
        details={"synced_doc_ids": synced_doc_ids, "count": len(synced_doc_ids)},
    )
    return synced_doc_ids


async def invalidate_collab_docs_or_503(
    project: Project,
    doc_ids: list[str],
    *,
    operation: str,
) -> list[str]:
    unique_doc_ids = list(dict.fromkeys(doc_id for doc_id in doc_ids if doc_id))
    if not unique_doc_ids:
        return []

    invalidated: list[str] = []
    gateway = CollabGateway()
    for doc_id in unique_doc_ids:
        try:
            result = await gateway.invalidate_doc(doc_id)
        except CollabGatewayError as exc:
            record_collab_event(
                "collab_doc_invalidate_failed",
                level="error",
                project_id=project.id,
                doc_id=doc_id,
                operation=operation,
                code="collab_invalidate_failed",
                message=str(exc),
                details={"invalidated_doc_ids": invalidated},
            )
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "collab_invalidate_failed",
                    "message": "Unable to invalidate stale collaboration rooms",
                },
            ) from exc
        invalidated.append(doc_id)
        record_collab_event(
            "collab_doc_invalidated",
            project_id=project.id,
            doc_id=doc_id,
            operation=operation,
            details=result,
        )
    return invalidated


def sync_collab_doc_from_db_or_503_sync(
    db: Session,
    project: Project,
    doc_id: str,
    *,
    operation: str,
) -> dict:
    return asyncio.run(
        sync_collab_doc_from_db_or_503(db, project, doc_id, operation=operation)
    )


def sync_project_collab_from_db_or_503_sync(
    db: Session,
    project: Project,
    *,
    operation: str,
) -> list[str]:
    return asyncio.run(sync_project_collab_from_db_or_503(db, project, operation=operation))


def invalidate_collab_docs_or_503_sync(
    project: Project,
    doc_ids: list[str],
    *,
    operation: str,
) -> list[str]:
    return asyncio.run(
        invalidate_collab_docs_or_503(project, doc_ids, operation=operation)
    )

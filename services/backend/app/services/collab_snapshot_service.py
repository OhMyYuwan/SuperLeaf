"""Periodic snapshot service for Yjs-managed documents.

Polls the collab-server HTTP API for active documents and snapshots their
current text into the SQLite `docs` table + version history. Runs as an
asyncio background task started on FastAPI startup.
"""

from __future__ import annotations

import asyncio
import logging

from ..database import SessionLocal
from ..models import Doc, Project
from ..settings import settings
from .collab_gateway import CollabGateway, CollabGatewayError
from .project_fs_service import ProjectFsService

logger = logging.getLogger(__name__)

_task: asyncio.Task | None = None


class CollabSnapshotError(RuntimeError):
    pass


def start_snapshot_loop() -> None:
    global _task
    if _task is not None:
        return
    _task = asyncio.create_task(_loop())
    logger.info(
        "[collab-snapshot] started (interval=%ds, server=%s)",
        settings.collab_snapshot_interval_s,
        settings.collab_server_url,
    )


def stop_snapshot_loop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        _task = None


async def _loop() -> None:
    interval = settings.collab_snapshot_interval_s
    base_url = settings.collab_server_url.rstrip("/")

    while True:
        await asyncio.sleep(interval)
        try:
            await _snapshot_active_docs(base_url)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[collab-snapshot] tick failed")


async def _snapshot_active_docs(base_url: str) -> None:
    """Fetch text from collab-server for every active Yjs room."""
    doc_ids = await _fetch_active_doc_ids(base_url)
    for doc_id in doc_ids:
        await snapshot_doc_from_collab(doc_id, base_url=base_url)


async def snapshot_project_from_collab(
    project_id: str,
    *,
    base_url: str | None = None,
) -> list[str]:
    """Flush active Yjs docs for a project into the database before DB-only work."""
    resolved_base_url = (base_url or settings.collab_server_url).rstrip("/")
    try:
        active_doc_ids = await _fetch_active_doc_ids(resolved_base_url)
    except CollabGatewayError as exc:
        raise CollabSnapshotError("failed to list active collaboration docs") from exc

    if not active_doc_ids:
        return []

    db = SessionLocal()
    try:
        rows = (
            db.query(Doc.id)
            .filter(Doc.project_id == project_id)
            .filter(Doc.id.in_(active_doc_ids))
            .all()
        )
        project_doc_ids = [str(row[0]) for row in rows]
    finally:
        db.close()

    flushed: list[str] = []
    for doc_id in project_doc_ids:
        doc = await snapshot_doc_from_collab(doc_id, base_url=resolved_base_url)
        if doc is None:
            raise CollabSnapshotError(f"failed to snapshot active doc {doc_id}")
        flushed.append(doc_id)
    return flushed


async def _fetch_active_doc_ids(base_url: str) -> list[str]:
    return await CollabGateway(base_url=base_url).get_active_doc_ids()


async def snapshot_doc_from_collab(doc_id: str, *, base_url: str | None = None) -> Doc | None:
    resolved_base_url = (base_url or settings.collab_server_url).rstrip("/")
    try:
        collab_text = await CollabGateway(base_url=resolved_base_url).get_doc_text(doc_id)
    except CollabGatewayError as exc:
        logger.debug("[collab-snapshot] failed to fetch doc %s", doc_id)
        raise CollabSnapshotError(f"failed to fetch collab doc {doc_id}") from exc

    if collab_text is None:
        logger.debug("[collab-snapshot] skipped uninitialized collab doc %s", doc_id)
        return None
    new_text = collab_text.text

    db = SessionLocal()
    try:
        doc = db.get(Doc, doc_id)
        if doc is None:
            return None
        if new_text == doc.content:
            return doc
        project = db.get(Project, doc.project_id)
        if project is None:
            logger.debug(
                "[collab-snapshot] skipped doc %s; project %s not found",
                doc.id,
                doc.project_id,
            )
            return None
        svc = ProjectFsService(db, project)
        updated = svc.update_doc_content(
            doc.id,
            new_text,
            origin="collab_snapshot",
            actor=None,
        )
        if updated is not None:
            logger.debug("[collab-snapshot] snapshotted doc %s", doc.id)
        return updated
    finally:
        db.close()

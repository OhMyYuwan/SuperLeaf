"""Periodic snapshot service for Yjs-managed documents.

Polls the collab-server HTTP API for active documents and snapshots their
current text into the SQLite `docs` table + version history. Runs as an
asyncio background task started on FastAPI startup.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from ..database import SessionLocal
from ..settings import settings
from .project_fs_service import ProjectFsService

logger = logging.getLogger(__name__)

_task: asyncio.Task | None = None


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
    """Fetch text from collab-server for all docs that have been opened."""
    # The collab-server doesn't expose a list of active docs via HTTP yet,
    # so we rely on the frontend telling us which docs are collaborative.
    # For now, we query the docs that have been recently updated (last 5 min)
    # and check if collab-server has them.
    db = SessionLocal()
    try:
        from datetime import datetime, timedelta

        from ..models import Doc, Project

        cutoff = datetime.utcnow() - timedelta(minutes=5)
        recent_docs = (
            db.query(Doc)
            .filter(Doc.updated_at >= cutoff)
            .all()
        )

        async with httpx.AsyncClient(timeout=10.0) as client:
            for doc in recent_docs:
                try:
                    resp = await client.get(f"{base_url}/docs/{doc.id}/text")
                    if resp.status_code != 200:
                        continue
                    data = resp.json()
                    new_text = data.get("text", "")
                    if not new_text or new_text == doc.content:
                        continue
                    # Update via service to get version bump + snapshot.
                    project = db.get(Project, doc.project_id)
                    if project is None:
                        logger.debug(
                            "[collab-snapshot] skipped doc %s; project %s not found",
                            doc.id,
                            doc.project_id,
                        )
                        continue
                    svc = ProjectFsService(db, project)
                    svc.update_doc_content(
                        doc.id,
                        new_text,
                        origin="collab_snapshot",
                        actor=None,
                    )
                    logger.debug("[collab-snapshot] snapshotted doc %s", doc.id)
                except httpx.HTTPError:
                    continue
    finally:
        db.close()

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
from ..models import Doc, Project
from ..settings import settings
from .project_fs_service import ProjectFsService

logger = logging.getLogger(__name__)

_task: asyncio.Task | None = None
_COLLAB_INTERNAL_TOKEN_HEADER = "X-SuperLeaf-Internal-Token"


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


async def _fetch_active_doc_ids(base_url: str) -> list[str]:
    url = f"{base_url.rstrip('/')}/docs/active"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, headers=_collab_internal_headers())
        resp.raise_for_status()
        data = resp.json()
    ids = data.get("doc_ids", [])
    if not isinstance(ids, list):
        return []
    return [str(doc_id) for doc_id in ids if doc_id is not None and str(doc_id)]


async def snapshot_doc_from_collab(doc_id: str, *, base_url: str | None = None) -> Doc | None:
    resolved_base_url = (base_url or settings.collab_server_url).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{resolved_base_url}/docs/{doc_id}/text",
                headers=_collab_internal_headers(),
            )
    except httpx.HTTPError:
        logger.debug("[collab-snapshot] failed to fetch doc %s", doc_id)
        return None

    if resp.status_code != 200:
        return None
    data = resp.json()
    new_text = data.get("text")
    if new_text is None:
        return None
    if not isinstance(new_text, str):
        new_text = str(new_text)

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


def _collab_internal_headers() -> dict[str, str]:
    token = settings.collab_internal_token.strip()
    if not token:
        return {}
    return {_COLLAB_INTERNAL_TOKEN_HEADER: token}

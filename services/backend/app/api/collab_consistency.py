"""Helpers that keep DB-only project operations consistent with Yjs state."""

from __future__ import annotations

import asyncio

from fastapi import HTTPException

from ..models import Project
from ..services import collab_snapshot_service
from ..services.collab_snapshot_service import CollabSnapshotError


async def flush_project_collab_or_503(project: Project) -> list[str]:
    try:
        return await collab_snapshot_service.snapshot_project_from_collab(project.id)
    except CollabSnapshotError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "collab_flush_failed",
                "message": "Unable to flush active collaboration state",
            },
        ) from exc


def flush_project_collab_or_503_sync(project: Project) -> list[str]:
    return asyncio.run(flush_project_collab_or_503(project))

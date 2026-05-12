"""/api/projects — list, create, rename, delete projects.

Per-user scoped: every endpoint requires a logged-in user and only operates
on projects owned by that user. Cross-user access returns 404.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from ..database import get_session
from ..models import Project, User
from ..schemas import ProjectCreateIn, ProjectOut, ProjectUpdateIn
from ..services.event_bus import bus
from ..services.project_service import LastProjectError, ProjectService
from .deps import get_current_user, get_project_from_path

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectOut])
def list_projects(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[ProjectOut]:
    svc = ProjectService(db)
    return [ProjectOut.model_validate(p) for p in svc.list(user_id=user.id)]


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    body: ProjectCreateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectOut:
    svc = ProjectService(db)
    p = svc.create(user_id=user.id, name=body.name)
    return ProjectOut.model_validate(p)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectOut:
    svc = ProjectService(db)
    p = svc.get(project_id, user_id=user.id)
    if p is None:
        raise HTTPException(404, "Project not found")
    return ProjectOut.model_validate(p)


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: str,
    body: ProjectUpdateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectOut:
    svc = ProjectService(db)
    p = svc.update(
        project_id,
        user_id=user.id,
        name=body.name,
        main_doc_id=body.main_doc_id,
        compiler=body.compiler,
    )
    if p is None:
        raise HTTPException(404, "Project not found")
    return ProjectOut.model_validate(p)


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> None:
    svc = ProjectService(db)
    try:
        ok = svc.delete(project_id, user_id=user.id)
    except LastProjectError as e:
        raise HTTPException(409, str(e)) from e
    if not ok:
        raise HTTPException(404, "Project not found")


# ---------------------------------------------------------------------------
# Real-time events (REQ-0034 phase 2)
# ---------------------------------------------------------------------------
#
# Long-lived SSE stream of per-project events. The client (one EventSource
# per browser tab) subscribes after login and the projectStore sets a
# currentProjectId. Events fire whenever any user with access to this
# project mutates annotations, evaluations, review_status, or doc content.
#
# Heartbeat every 25s keeps proxies from idle-closing the connection.
# Browser EventSource auto-reconnects on close; the client also passes
# `Last-Event-ID` so we can (someday) replay missed events from a log. For
# now we don't have a persistence ring — missed events are recovered via
# the focus/visibility refresh path in WorkspacePage.


@router.get("/{project_id}/events")
async def project_events(
    project: Project = Depends(get_project_from_path),
) -> EventSourceResponse:
    sub = await bus.subscribe(project.id)

    async def event_gen():
        # Greet so the client knows the stream is live (and so any sniffers
        # see at least one event quickly).
        yield {
            "event": "ylw.hello",
            "data": json.dumps({"project_id": project.id}),
        }
        try:
            while True:
                try:
                    evt = await asyncio.wait_for(sub.queue.get(), timeout=25.0)
                except asyncio.TimeoutError:
                    # SSE comments (lines starting with `:`) keep the
                    # connection alive without firing client handlers.
                    yield {"event": "ylw.heartbeat", "data": "{}"}
                    continue
                yield {
                    "id": evt["id"],
                    "event": evt["type"],
                    "data": json.dumps(evt),
                }
        finally:
            await bus.unsubscribe(sub)

    return EventSourceResponse(event_gen())

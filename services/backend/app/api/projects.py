"""/api/projects — list, create, rename, delete projects.

Per-user scoped: every endpoint requires a logged-in user and only operates
on projects owned by that user. Cross-user access returns 404.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session, object_session
from sse_starlette.sse import EventSourceResponse

from ..database import get_session
from ..models import Notification, Project, User
from ..schemas import (
    GitHubProjectImportIn,
    ProjectCreateIn,
    ProjectMemberAddIn,
    ProjectMemberOut,
    ProjectOut,
    ProjectSkillCacheOut,
    ProjectUpdateIn,
    RecentCollaboratorOut,
    SkillOut,
)
from ..services.annotation_training_export_service import build_annotation_training_export_zip
from ..services.event_bus import bus
from ..services.github_service import GitHubError, GitHubService, parse_repo_url
from ..services.native_agent_service import NativeAgentService
from ..services.project_member_service import ProjectMemberService
from ..services.project_service import LastProjectError, ProjectService
from ..services.skill_content_crypto import decrypt_skill_content
from .deps import get_current_user, get_project_from_path

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _project_out(p: Project, role: str) -> ProjectOut:
    out = ProjectOut.model_validate(p)
    out.my_role = role
    return out


def _skill_out(row, user_id: str) -> SkillOut:
    out = SkillOut.model_validate(row, from_attributes=True)
    session = object_session(row)
    if session:
        svc = NativeAgentService(session)
        out.can_edit = svc.can_edit_skill(row, user_id=user_id)
        out.used_by_agent_count = len(svc.agents_using_skill(row.id, user_id=user_id))
    out.content = decrypt_skill_content(row.content)
    return out


@router.get("", response_model=list[ProjectOut])
def list_projects(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[ProjectOut]:
    svc = ProjectService(db)
    member_svc = ProjectMemberService(db)
    owned = svc.list(user_id=user.id)
    result = [_project_out(p, "owner") for p in owned]
    shared = member_svc.list_shared_projects(user.id)
    for project, member in shared:
        result.append(_project_out(project, member.role))
    return result


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    body: ProjectCreateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectOut:
    svc = ProjectService(db)
    p = svc.create(user_id=user.id, name=body.name, project_type=body.project_type)
    return ProjectOut.model_validate(p)


@router.post("/import/github", response_model=ProjectOut, status_code=201)
def import_github_project(
    body: GitHubProjectImportIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectOut:
    svc = ProjectService(db)
    try:
        repo_ref = parse_repo_url(body.repo_url)
        name = (body.name or repo_ref.repo).strip()
        project = svc.create(user_id=user.id, name=name)
        GitHubService(db, user).import_repo_into_project(
            project,
            repo_url=body.repo_url,
            branch=body.branch,
        )
    except GitHubError as e:
        raise HTTPException(400, str(e)) from e
    return ProjectOut.model_validate(project)


@router.get("/recent-collaborators", response_model=list[RecentCollaboratorOut])
def list_recent_collaborators(
    limit: int = Query(default=20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[RecentCollaboratorOut]:
    """List users this account has collaborated with recently."""
    svc = ProjectMemberService(db)
    rows = svc.list_recent_collaborators(user.id, limit=limit)
    return [
        RecentCollaboratorOut(
            id=row.id,
            user_id=row.collaborator_user_id,
            email=row.collaborator_email,
            display_name=row.collaborator_display_name or row.collaborator_email,
            last_collaborated_at=row.last_collaborated_at,
        )
        for row in rows
    ]


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
        is_skill_project=body.is_skill_project,
    )
    if p is None:
        raise HTTPException(404, "Project not found")
    return ProjectOut.model_validate(p)


@router.post("/{project_id}/skill-cache", response_model=ProjectSkillCacheOut)
def update_project_skill_cache(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectSkillCacheOut:
    project = db.get(Project, project_id)
    if project is None or not ProjectMemberService(db).has_access(project.id, user.id):
        raise HTTPException(404, "Project not found")
    try:
        skill = NativeAgentService(db).update_project_skill_cache(project, user_id=user.id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return ProjectSkillCacheOut(
        project=ProjectOut.model_validate(project),
        skill=_skill_out(skill, user.id),
    )


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


@router.get("/{project_id}/annotation-training-export")
def export_annotation_training_data(
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
    only_training_candidates: bool = Query(default=False),
) -> Response:
    """Download annotation evaluation samples for external wiki/skill building."""
    zip_bytes = build_annotation_training_export_zip(
        db,
        project=project,
        user=user,
        only_training_candidates=only_training_candidates,
    )
    safe_name = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in project.name).strip("-")
    filename = f"{safe_name or 'project'}-annotation-training-export.zip"
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Project members (multi-user collaboration)
# ---------------------------------------------------------------------------


@router.get("/{project_id}/members", response_model=list[ProjectMemberOut])
def list_project_members(
    project: Project = Depends(get_project_from_path),
    db: Session = Depends(get_session),
) -> list[ProjectMemberOut]:
    """List all members of a project."""
    svc = ProjectMemberService(db)
    members = svc.list_members(project.id)
    return [
        ProjectMemberOut(
            id=member.id,
            project_id=member.project_id,
            user_id=member.user_id,
            user_email=user.email,
            user_display_name=user.display_name or user.email,
            role=member.role,
            status=member.status,
            created_at=member.created_at,
        )
        for member, user in members
    ]


@router.post("/{project_id}/members", response_model=ProjectMemberOut, status_code=201)
def add_project_member(
    project_id: str,
    body: ProjectMemberAddIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectMemberOut:
    """Add a member to a project. Only the project owner can add members."""
    # Check if user is the project owner
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    if project.user_id != user.id:
        raise HTTPException(403, "Only the project owner can add members")

    svc = ProjectMemberService(db)
    member = svc.add_member(project_id, body.email, body.role, user.id)
    if member is None:
        raise HTTPException(404, f"User with email {body.email} not found")

    # Create notification for the invited user
    notification = Notification(
        user_id=member.user_id,
        kind="project_invite",
        title=f"你已被邀请加入项目「{project.name}」",
        body=f"{user.display_name or user.email} 邀请你以{('编辑' if body.role == 'editor' else '查看')}权限加入项目。",
        target_id=project_id,
        target_type="project",
    )
    db.add(notification)
    db.commit()

    # Get user info for response
    member_user = db.get(User, member.user_id)
    return ProjectMemberOut(
        id=member.id,
        project_id=member.project_id,
        user_id=member.user_id,
        user_email=member_user.email,
        user_display_name=member_user.display_name or member_user.email,
        role=member.role,
        status=member.status,
        created_at=member.created_at,
    )


@router.delete("/{project_id}/members/{user_id}", status_code=204)
def remove_project_member(
    project_id: str,
    user_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> None:
    """Remove a member from a project. Only the project owner can remove members."""
    # Check if user is the project owner
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    if project.user_id != user.id:
        raise HTTPException(403, "Only the project owner can remove members")

    svc = ProjectMemberService(db)
    ok = svc.remove_member(project_id, user_id)
    if not ok:
        raise HTTPException(404, "Member not found")


@router.get("/{project_id}/online")
def get_online_users_endpoint(
    project: Project = Depends(get_project_from_path),
) -> list[dict]:
    """Return list of users currently connected to this project's SSE stream."""
    from ..services.event_bus import get_online_users
    return get_online_users(project.id)


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
    user: User = Depends(get_current_user),
) -> EventSourceResponse:
    sub = await bus.subscribe(project.id, user_id=user.id, user_display_name=user.display_name or user.email)

    async def event_gen():
        yield {
            "event": "ylw.hello",
            "data": json.dumps({"project_id": project.id}),
        }
        try:
            while True:
                try:
                    evt = await asyncio.wait_for(sub.queue.get(), timeout=25.0)
                except asyncio.TimeoutError:
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

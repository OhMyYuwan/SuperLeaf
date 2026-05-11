"""/api/projects — list, create, rename, delete projects.

Per-user scoped: every endpoint requires a logged-in user and only operates
on projects owned by that user. Cross-user access returns 404.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import User
from ..schemas import ProjectCreateIn, ProjectOut, ProjectUpdateIn
from ..services.project_service import LastProjectError, ProjectService
from .deps import get_current_user

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

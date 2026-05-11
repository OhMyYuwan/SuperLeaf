"""Shared FastAPI dependencies.

`get_current_user` resolves the session cookie to a User; `get_current_project`
chains on top to enforce ownership. Cross-user project access returns 404
(not 403) so users cannot probe whether a project id belongs to someone else.
"""

from __future__ import annotations

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Project, User
from ..services.auth_service import AuthService


SESSION_COOKIE_NAME = "ylw_session"


def get_optional_current_user(
    request: Request,
    db: Session = Depends(get_session),
) -> User | None:
    sid = request.cookies.get(SESSION_COOKIE_NAME)
    if not sid:
        return None
    sess = AuthService(db).get_session(sid)
    if sess is None:
        return None
    user = db.get(User, sess.user_id)
    if user is None or user.is_disabled:
        return None
    return user


def get_current_user(
    user: User | None = Depends(get_optional_current_user),
) -> User:
    if user is None:
        raise HTTPException(401, "Not authenticated")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "Admin required")
    return user


def get_current_project(
    x_project_id: str | None = Header(default=None, alias="X-Project-Id"),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> Project:
    if not x_project_id:
        raise HTTPException(400, "Missing X-Project-Id header")
    project = db.get(Project, x_project_id)
    # Hide existence from non-owners by returning the same 404 shape.
    if project is None or project.user_id != user.id:
        raise HTTPException(404, "Project not found")
    return project


def get_project_from_path(
    project_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> Project:
    project = db.get(Project, project_id)
    if project is None or project.user_id != user.id:
        raise HTTPException(404, "Project not found")
    return project

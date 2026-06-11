"""Shared FastAPI dependencies.

`get_current_user` resolves the session cookie to a User; `get_current_project`
chains on top to enforce ownership or membership. Cross-user project access
returns 404 (not 403) so users cannot probe whether a project id belongs to
someone else.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import McpToken, Project, User
from ..services.auth_service import AuthService
from ..services.mcp_token_service import McpTokenService
from ..services.project_member_service import ProjectMemberService


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
    if project is None:
        raise HTTPException(404, "Project not found")
    # Allow access if user is owner or member
    member_svc = ProjectMemberService(db)
    if not member_svc.has_access(x_project_id, user.id):
        raise HTTPException(404, "Project not found")
    return project


def get_project_from_path(
    project_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    # Allow access if user is owner or member
    member_svc = ProjectMemberService(db)
    if not member_svc.has_access(project_id, user.id):
        raise HTTPException(404, "Project not found")
    return project


def require_write_access(
    x_project_id: str | None = Header(default=None, alias="X-Project-Id"),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> Project:
    """Like get_current_project but also checks that the user can write (not viewer)."""
    if not x_project_id:
        raise HTTPException(400, "Missing X-Project-Id header")
    project = db.get(Project, x_project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    member_svc = ProjectMemberService(db)
    if not member_svc.can_write(x_project_id, user.id):
        raise HTTPException(403, "Read-only access")
    return project


# ---------------------------------------------------------------------------
# MCP token authentication (IDE/CLI clients)
#
# These dependencies resolve a `Authorization: Bearer slmcp_...` header to a
# user via the mcp_tokens table, completely independent of the browser session
# cookie. The resolved context carries the token scope so write tools can be
# gated without a second lookup.
# ---------------------------------------------------------------------------


@dataclass
class McpAuthContext:
    user: User
    token: McpToken

    @property
    def scope(self) -> str:
        return self.token.scope or "read"

    @property
    def can_write(self) -> bool:
        return self.scope == "write"


def _bearer_token(authorization: str | None) -> str:
    if not authorization:
        return ""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return ""
    return token.strip()


def get_mcp_auth(
    request: Request,
    authorization: str | None = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_session),
) -> McpAuthContext:
    """Resolve an MCP bearer token to its owning user, or raise 401."""
    token = _bearer_token(authorization)
    if not token:
        raise HTTPException(401, "Missing MCP bearer token")
    client_ip = request.client.host if request.client else ""
    resolved = McpTokenService(db).verify_token(token, ip=client_ip or "")
    if resolved is None:
        raise HTTPException(401, "Invalid or expired MCP token")
    user, row = resolved
    return McpAuthContext(user=user, token=row)


def require_mcp_write(
    ctx: McpAuthContext = Depends(get_mcp_auth),
) -> McpAuthContext:
    if not ctx.can_write:
        raise HTTPException(403, "This MCP token is read-only (scope=read)")
    return ctx

"""/api/auth — register, login, logout, me.

These routes are global (no `X-Project-Id`). They set / clear the
`ylw_session` HttpOnly cookie. Successful register / login return the User
record AND the Set-Cookie header.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import User
from ..schemas import UserLoginIn, UserOut, UserRegisterIn
from ..services.auth_service import AuthError, AuthService, SESSION_LIFETIME
from .deps import SESSION_COOKIE_NAME, get_current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _set_session_cookie(response: Response, sid: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=sid,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        samesite="lax",
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/")


def _client_ip(request: Request) -> str:
    if request.client is None:
        return ""
    return request.client.host or ""


@router.post("/register", response_model=UserOut, status_code=201)
def register(
    body: UserRegisterIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_session),
) -> UserOut:
    svc = AuthService(db)
    try:
        user, sid = svc.register(
            email=body.email,
            password=body.password,
            display_name=body.display_name,
            ip=_client_ip(request),
        )
    except AuthError as e:
        raise HTTPException(400, str(e)) from e
    _set_session_cookie(response, sid)
    return UserOut.model_validate(user)


@router.post("/login", response_model=UserOut)
def login(
    body: UserLoginIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_session),
) -> UserOut:
    svc = AuthService(db)
    try:
        user, sid = svc.authenticate(
            email=body.email, password=body.password, ip=_client_ip(request)
        )
    except AuthError as e:
        raise HTTPException(401, str(e)) from e
    _set_session_cookie(response, sid)
    return UserOut.model_validate(user)


@router.post("/logout", status_code=204)
def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_session),
) -> None:
    sid = request.cookies.get(SESSION_COOKIE_NAME)
    if sid:
        AuthService(db).logout(sid)
    _clear_session_cookie(response)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.model_validate(user)


@router.get("/verify")
def verify_token(
    token: str,
    db: Session = Depends(get_session),
):
    """Verify a session token (used by collab-server on WebSocket upgrade).

    Returns {user_id, display_name} or 401.
    """
    sess = AuthService(db).get_session(token)
    if sess is None:
        raise HTTPException(401, "Invalid or expired token")
    user = db.get(User, sess.user_id)
    if user is None or user.is_disabled:
        raise HTTPException(401, "User not found or disabled")
    return {"user_id": user.id, "display_name": user.display_name}


@router.get("/collab-token")
def get_collab_token(
    request: Request,
    user: User = Depends(get_current_user),
):
    """Return the session ID as a collab token for WebSocket auth.

    The frontend can't read the HttpOnly cookie directly, so this endpoint
    echoes it back. The collab-server then verifies it via /api/auth/verify.
    """
    sid = request.cookies.get(SESSION_COOKIE_NAME)
    if not sid:
        raise HTTPException(401, "No session")
    return {"token": sid}

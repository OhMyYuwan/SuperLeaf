"""/api/auth — register, login, logout, me.

These routes are global (no `X-Project-Id`). They set / clear the
`ylw_session` HttpOnly cookie. Successful register / login return the User
record AND the Set-Cookie header.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Doc, User
from ..schemas import UserLoginIn, UserOut, UserRegisterIn
from ..services.auth_service import (
    SESSION_LIFETIME,
    AuthError,
    AuthService,
    RegistrationClosedError,
)
from ..services.project_member_service import ProjectMemberService
from ..settings import settings
from .deps import SESSION_COOKIE_NAME, get_current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _request_uses_https(request: Request) -> bool:
    forwarded_proto = request.headers.get("x-forwarded-proto", "")
    forwarded_values = [value.strip().lower() for value in forwarded_proto.split(",")]
    return request.url.scheme == "https" or "https" in forwarded_values


def _session_cookie_secure(request: Request) -> bool:
    value = settings.cookie_secure.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return _request_uses_https(request)


def _set_session_cookie(response: Response, request: Request, sid: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=sid,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        samesite="lax",
        path="/",
        secure=_session_cookie_secure(request),
    )


def _clear_session_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/", secure=_session_cookie_secure(request))


def _client_ip(request: Request) -> str:
    if request.client is None:
        return ""
    return request.client.host or ""


def _bearer_token(authorization: str | None) -> str:
    if not authorization:
        return ""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return ""
    return token.strip()


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
            bootstrap_token=body.bootstrap_token,
            invite_token=body.invite_token,
        )
    except RegistrationClosedError as e:
        raise HTTPException(403, str(e)) from e
    except AuthError as e:
        raise HTTPException(400, str(e)) from e
    _set_session_cookie(response, request, sid)
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
    _set_session_cookie(response, request, sid)
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
    _clear_session_cookie(response, request)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.model_validate(user)


@router.get("/verify")
def verify_token(
    authorization: str | None = Header(default=None, alias="Authorization"),
    doc_id: str | None = None,
    db: Session = Depends(get_session),
):
    """Verify a short-lived collab token.

    Used by collab-server on WebSocket upgrade. Tokens must arrive via the
    Authorization header so they do not leak through URLs or access logs.
    """
    auth_svc = AuthService(db)
    record = auth_svc.verify_collab_token(_bearer_token(authorization), doc_id=doc_id)
    if record is None:
        raise HTTPException(401, "Invalid or expired token")
    user = db.get(User, record.user_id)
    if user is None or user.is_disabled:
        raise HTTPException(401, "User not found or disabled")
    if doc_id is not None:
        doc = db.get(Doc, doc_id)
        if doc is None or not ProjectMemberService(db).has_access(doc.project_id, user.id):
            raise HTTPException(404, "doc not found")
    return {"user_id": user.id, "display_name": user.display_name}


@router.get("/collab-token")
def get_collab_token(
    doc_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Issue a short-lived, document-scoped token for WebSocket auth.

    This deliberately does not return the HttpOnly session cookie. The token
    is only useful for the requested document and expires quickly.
    """
    doc = db.get(Doc, doc_id)
    if doc is None or not ProjectMemberService(db).has_access(doc.project_id, user.id):
        raise HTTPException(404, "doc not found")
    token, expires_in = AuthService(db).issue_collab_token(user_id=user.id, doc_id=doc.id)
    return {"token": token, "expires_in": expires_in}

"""/api/users — admin-only user management.

Mounts under `Depends(require_admin)` for every route. Endpoints:
  GET    /api/users           list all users
  PATCH  /api/users/{id}      flip is_disabled / is_admin / display_name
  DELETE /api/users/{id}      cascade-delete (refuses last admin)
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import SessionLocal, get_session
from ..models import User
from ..schemas import (
    RegistrationInviteCreateIn,
    RegistrationInviteCreateOut,
    RegistrationInviteEmailStatusOut,
    RegistrationInviteOut,
    UserOut,
    UserUpdateIn,
)
from ..services.email_service import EmailNotConfiguredError, EmailService
from ..services.registration_invite_service import (
    RegistrationInviteError,
    RegistrationInviteIssue,
    RegistrationInviteService,
)
from ..services.user_service import LastAdminError, UserService
from .deps import require_admin

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=list[UserOut])
def list_users(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
) -> list[UserOut]:
    return [UserOut.model_validate(u) for u in UserService(db).list()]


@router.get("/invites/email-status", response_model=RegistrationInviteEmailStatusOut)
def invite_email_status(
    _admin: User = Depends(require_admin),
) -> RegistrationInviteEmailStatusOut:
    return RegistrationInviteEmailStatusOut(
        smtp_configured=EmailService().is_configured(),
        from_email=EmailService().from_email(),
    )


@router.get("/invites", response_model=list[RegistrationInviteOut])
def list_registration_invites(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
) -> list[RegistrationInviteOut]:
    invites = RegistrationInviteService(db).list_invites()
    return [RegistrationInviteOut.model_validate(invite) for invite in invites]


@router.post("/invites", response_model=RegistrationInviteCreateOut, status_code=201)
def create_registration_invite(
    body: RegistrationInviteCreateIn,
    background_tasks: BackgroundTasks,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
) -> RegistrationInviteCreateOut:
    if body.send_email and not body.email.strip():
        raise HTTPException(400, "Invite email is required for email delivery")
    svc = RegistrationInviteService(db)
    try:
        issue = svc.create_invite(
            created_by_user_id=admin.id,
            email=body.email,
            expires_in_days=body.expires_in_days,
            note=body.note,
            send_status="queued" if body.send_email else "not_requested",
        )
    except RegistrationInviteError as e:
        raise HTTPException(400, str(e)) from e
    if body.send_email:
        _schedule_invite_email(background_tasks, issue)
    return _invite_issue_out(issue)


@router.post("/invites/{invite_id}/resend", response_model=RegistrationInviteCreateOut)
def resend_registration_invite(
    invite_id: str,
    background_tasks: BackgroundTasks,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
) -> RegistrationInviteCreateOut:
    svc = RegistrationInviteService(db)
    invite = svc.get(invite_id)
    if invite is None:
        raise HTTPException(404, "Invite not found")
    if not invite.email.strip():
        raise HTTPException(400, "Invite has no email address")
    try:
        issue = svc.rotate_invite(invite_id, send_status="queued")
    except RegistrationInviteError as e:
        raise HTTPException(409, str(e)) from e
    _schedule_invite_email(background_tasks, issue)
    return _invite_issue_out(issue)


@router.delete("/invites/{invite_id}", response_model=RegistrationInviteOut)
def revoke_registration_invite(
    invite_id: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
) -> RegistrationInviteOut:
    invite = RegistrationInviteService(db).revoke(invite_id)
    if invite is None:
        raise HTTPException(404, "Invite not found")
    return RegistrationInviteOut.model_validate(invite)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: str,
    body: UserUpdateIn,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
) -> UserOut:
    try:
        u = UserService(db).update(
            user_id,
            is_disabled=body.is_disabled,
            is_admin=body.is_admin,
            display_name=body.display_name,
        )
    except LastAdminError as e:
        raise HTTPException(409, str(e)) from e
    if u is None:
        raise HTTPException(404, "User not found")
    return UserOut.model_validate(u)


@router.delete("/{user_id}", status_code=204)
def delete_user(
    user_id: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
) -> None:
    try:
        ok = UserService(db).delete(user_id)
    except LastAdminError as e:
        raise HTTPException(409, str(e)) from e
    if not ok:
        raise HTTPException(404, "User not found")


def _invite_issue_out(issue: RegistrationInviteIssue) -> RegistrationInviteCreateOut:
    return RegistrationInviteCreateOut(
        **RegistrationInviteOut.model_validate(issue.invite).model_dump(),
        token=issue.token,
        invite_url=issue.invite_url,
        smtp_configured=EmailService().is_configured(),
    )


def _schedule_invite_email(
    background_tasks: BackgroundTasks,
    issue: RegistrationInviteIssue,
) -> None:
    background_tasks.add_task(
        _send_invite_email_task,
        issue.invite.id,
        issue.invite.email,
        issue.invite_url,
        issue.invite.expires_at,
    )


def _send_invite_email_task(
    invite_id: str,
    email: str,
    invite_url: str,
    expires_at,
) -> None:
    with SessionLocal() as db:
        svc = RegistrationInviteService(db)
        try:
            EmailService().send_registration_invite(
                to_email=email,
                invite_url=invite_url,
                expires_at=expires_at,
            )
        except EmailNotConfiguredError as e:
            svc.mark_send_status(invite_id, status="not_configured", error=str(e))
        except Exception as e:
            svc.mark_send_status(invite_id, status="failed", error=str(e))
        else:
            svc.mark_send_status(invite_id, status="sent")

"""Admin-issued one-time registration invitations."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlencode

from sqlalchemy.orm import Session as DbSession

from ..models import RegistrationInvite
from ..settings import settings


class RegistrationInviteError(Exception):
    """Raised when an invitation cannot be created or consumed."""


@dataclass(frozen=True)
class RegistrationInviteIssue:
    invite: RegistrationInvite
    token: str
    invite_url: str


def normalize_invite_email(email: str) -> str:
    return email.strip().lower()


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class RegistrationInviteService:
    def __init__(self, db: DbSession) -> None:
        self.db = db

    def list_invites(self, limit: int = 200) -> list[RegistrationInvite]:
        return (
            self.db.query(RegistrationInvite)
            .order_by(RegistrationInvite.created_at.desc())
            .limit(max(1, min(limit, 500)))
            .all()
        )

    def get(self, invite_id: str) -> RegistrationInvite | None:
        return self.db.get(RegistrationInvite, invite_id)

    def create_invite(
        self,
        *,
        created_by_user_id: str,
        email: str = "",
        expires_in_days: int | None = None,
        note: str = "",
        send_status: str = "not_requested",
    ) -> RegistrationInviteIssue:
        email_normalized = normalize_invite_email(email)
        if email_normalized and "@" not in email_normalized:
            raise RegistrationInviteError("Invalid invite email")
        token = self._new_unique_token()
        now = datetime.utcnow()
        days = expires_in_days if expires_in_days is not None else settings.registration_invite_ttl_days
        expires_at = now + timedelta(days=max(1, min(int(days), 365)))
        invite = RegistrationInvite(
            email=email_normalized,
            token_hash=hash_invite_token(token),
            token_hint=token[-6:],
            created_by_user_id=created_by_user_id,
            created_at=now,
            expires_at=expires_at,
            send_status=send_status,
            note=note.strip(),
        )
        self.db.add(invite)
        self.db.commit()
        self.db.refresh(invite)
        return RegistrationInviteIssue(
            invite=invite,
            token=token,
            invite_url=self.build_invite_url(token),
        )

    def rotate_invite(self, invite_id: str, *, send_status: str = "queued") -> RegistrationInviteIssue:
        invite = self.db.get(RegistrationInvite, invite_id)
        if invite is None:
            raise RegistrationInviteError("Invite not found")
        if invite.used_at is not None:
            raise RegistrationInviteError("Invite has already been used")
        if invite.revoked_at is not None:
            raise RegistrationInviteError("Invite has been revoked")
        token = self._new_unique_token()
        invite.token_hash = hash_invite_token(token)
        invite.token_hint = token[-6:]
        invite.send_status = send_status
        invite.send_error = ""
        if invite.expires_at is not None and invite.expires_at < datetime.utcnow():
            invite.expires_at = datetime.utcnow() + timedelta(
                days=max(1, settings.registration_invite_ttl_days)
            )
        self.db.commit()
        self.db.refresh(invite)
        return RegistrationInviteIssue(
            invite=invite,
            token=token,
            invite_url=self.build_invite_url(token),
        )

    def revoke(self, invite_id: str) -> RegistrationInvite | None:
        invite = self.db.get(RegistrationInvite, invite_id)
        if invite is None:
            return None
        if invite.revoked_at is None:
            invite.revoked_at = datetime.utcnow()
            invite.send_status = "revoked"
            self.db.commit()
            self.db.refresh(invite)
        return invite

    def assert_available(self, token: str, *, email: str) -> RegistrationInvite:
        invite = self._find_by_token(token)
        if invite is None:
            raise RegistrationInviteError("Registration invite is invalid or expired")
        now = datetime.utcnow()
        if invite.revoked_at is not None or invite.used_at is not None:
            raise RegistrationInviteError("Registration invite is invalid or expired")
        if invite.expires_at is not None and invite.expires_at < now:
            raise RegistrationInviteError("Registration invite is invalid or expired")
        email_normalized = normalize_invite_email(email)
        if invite.email and invite.email != email_normalized:
            raise RegistrationInviteError("Registration invite does not match this email")
        return invite

    def consume(self, token: str, *, email: str, used_by_user_id: str) -> RegistrationInvite:
        invite = self.assert_available(token, email=email)
        invite.used_at = datetime.utcnow()
        invite.used_by_user_id = used_by_user_id
        invite.send_status = "used"
        self.db.flush()
        return invite

    def mark_send_status(self, invite_id: str, *, status: str, error: str = "") -> None:
        invite = self.db.get(RegistrationInvite, invite_id)
        if invite is None:
            return
        invite.send_status = status
        invite.send_error = error[:2000]
        if status == "sent":
            invite.last_sent_at = datetime.utcnow()
        self.db.commit()

    @staticmethod
    def build_invite_url(token: str) -> str:
        query = urlencode({"invite": token})
        base = settings.public_base_url.strip().rstrip("/")
        if not base:
            return f"/register?{query}"
        return f"{base}/register?{query}"

    def _find_by_token(self, token: str) -> RegistrationInvite | None:
        token = token.strip()
        if not token:
            return None
        return (
            self.db.query(RegistrationInvite)
            .filter(RegistrationInvite.token_hash == hash_invite_token(token))
            .first()
        )

    def _new_unique_token(self) -> str:
        for _ in range(5):
            token = secrets.token_urlsafe(24)
            exists = (
                self.db.query(RegistrationInvite.id)
                .filter(RegistrationInvite.token_hash == hash_invite_token(token))
                .first()
            )
            if exists is None:
                return token
        raise RegistrationInviteError("Could not generate a unique invite token")

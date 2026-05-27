"""Auth service: password hashing, registration, login, sessions.

Sessions are server-side opaque tokens stored in the `sessions` table. The
token itself is the value of the `ylw_session` cookie. Revocation flips
`revoked=True`; there's no refresh-token dance.

The first user to register with deployment bootstrap authorization is promoted
to admin AND inherits
ownership of any pre-existing `user_id=''` rows across `projects`, `providers`,
and `cached_workflows`. This is the migration path from single-user to
multi-user — we cannot do it inside the startup migration because no user
exists at that point.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from threading import Lock

import bcrypt
from sqlalchemy.orm import Session as DbSession

from ..models import (
    Annotation,
    AnnotationEvaluation,
    AnnotationReviewState,
    CachedWorkflow,
    Conversation,
    Project,
    Provider,
    Session,
    User,
    WorkflowDefinition,
    WorkflowRun,
)
from ..settings import settings

SESSION_LIFETIME = timedelta(days=14)
_PASSWORD_POLICY = re.compile(r"^(?=.*[A-Za-z])(?=.*\d).{8,}$")
_COLLAB_TOKEN_LOCK = Lock()
_COLLAB_TOKENS: dict[str, "CollabTokenRecord"] = {}


@dataclass(frozen=True)
class CollabTokenRecord:
    user_id: str
    doc_id: str
    expires_at: datetime


class AuthError(Exception):
    """Raised for bad credentials / disabled / policy violations."""


class RegistrationClosedError(AuthError):
    """Raised when deployment registration policy blocks account creation."""


class AuthService:
    def __init__(self, db: DbSession) -> None:
        self.db = db

    # ---- password --------------------------------------------------------

    @staticmethod
    def hash_password(plain: str) -> str:
        # bcrypt truncates inputs past 72 bytes; enforce the limit upfront so
        # users do not silently authenticate with a truncated password.
        if len(plain.encode("utf-8")) > 72:
            raise AuthError("Password too long (max 72 bytes)")
        return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("ascii")

    @staticmethod
    def verify_password(plain: str, hashed: str) -> bool:
        try:
            return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("ascii"))
        except (ValueError, TypeError):
            return False

    @staticmethod
    def _check_policy(password: str) -> None:
        if not _PASSWORD_POLICY.match(password):
            raise AuthError("Password must be >=8 chars and contain both letters and digits")

    # ---- register / login ------------------------------------------------

    def register(
        self,
        email: str,
        password: str,
        display_name: str = "",
        ip: str = "",
        bootstrap_token: str = "",
    ) -> tuple[User, str]:
        email_normalized = email.strip().lower()
        if not email_normalized or "@" not in email_normalized:
            raise AuthError("Invalid email")
        self._check_policy(password)

        existing = self.db.query(User).filter(User.email == email_normalized).first()
        if existing is not None:
            raise AuthError("Email already registered")

        is_first = self.db.query(User).count() == 0
        self._check_registration_policy(is_first=is_first, bootstrap_token=bootstrap_token)
        user = User(
            email=email_normalized,
            password_hash=self.hash_password(password),
            display_name=display_name.strip(),
            is_admin=is_first,
        )
        self.db.add(user)
        self.db.flush()  # populate user.id

        if is_first:
            self._backfill_existing_resources(user.id)

        token = self._create_session(user, ip)
        user.last_login_at = datetime.utcnow()
        user.last_login_ip = ip
        self.db.commit()
        self.db.refresh(user)
        return user, token

    @staticmethod
    def _check_registration_policy(*, is_first: bool, bootstrap_token: str) -> None:
        if is_first:
            required_token = settings.bootstrap_token.strip()
            if required_token:
                supplied_token = bootstrap_token.strip()
                if not secrets.compare_digest(supplied_token, required_token):
                    raise RegistrationClosedError("Registration requires a valid bootstrap token")
                return
            if settings.public_registration:
                return
            raise RegistrationClosedError("Registration requires a bootstrap token")

        if not settings.public_registration:
            raise RegistrationClosedError("Registration is disabled")

    def authenticate(self, email: str, password: str, ip: str = "") -> tuple[User, str]:
        email_normalized = email.strip().lower()
        user = self.db.query(User).filter(User.email == email_normalized).first()
        if user is None or not self.verify_password(password, user.password_hash):
            raise AuthError("Invalid email or password")
        if user.is_disabled:
            raise AuthError("Account disabled")
        token = self._create_session(user, ip)
        user.last_login_at = datetime.utcnow()
        user.last_login_ip = ip
        self.db.commit()
        self.db.refresh(user)
        return user, token

    # ---- short-lived collaboration tokens --------------------------------

    def issue_collab_token(self, *, user_id: str, doc_id: str) -> tuple[str, int]:
        lifetime_seconds = max(5, min(int(settings.collab_token_lifetime_seconds), 300))
        now = datetime.utcnow()
        token = secrets.token_urlsafe(32)
        record = CollabTokenRecord(
            user_id=user_id,
            doc_id=doc_id,
            expires_at=now + timedelta(seconds=lifetime_seconds),
        )
        with _COLLAB_TOKEN_LOCK:
            self._prune_collab_tokens(now)
            _COLLAB_TOKENS[token] = record
        return token, lifetime_seconds

    def verify_collab_token(self, token: str, *, doc_id: str | None = None) -> CollabTokenRecord | None:
        if not token:
            return None
        now = datetime.utcnow()
        with _COLLAB_TOKEN_LOCK:
            self._prune_collab_tokens(now)
            record = _COLLAB_TOKENS.get(token)
        if record is None:
            return None
        if doc_id is not None and record.doc_id != doc_id:
            return None
        return record

    @staticmethod
    def _prune_collab_tokens(now: datetime) -> None:
        expired = [token for token, record in _COLLAB_TOKENS.items() if record.expires_at < now]
        for token in expired:
            _COLLAB_TOKENS.pop(token, None)

    # ---- sessions --------------------------------------------------------

    def _create_session(self, user: User, ip: str) -> str:
        sid = secrets.token_urlsafe(32)
        now = datetime.utcnow()
        self.db.add(
            Session(
                id=sid,
                user_id=user.id,
                created_at=now,
                expires_at=now + SESSION_LIFETIME,
                revoked=False,
                last_seen_at=now,
                ip=ip,
            )
        )
        return sid

    def get_session(self, session_id: str) -> Session | None:
        if not session_id:
            return None
        sess = self.db.get(Session, session_id)
        if sess is None or sess.revoked:
            return None
        if sess.expires_at < datetime.utcnow():
            return None
        return sess

    def touch_session(self, session_id: str) -> None:
        sess = self.db.get(Session, session_id)
        if sess is None:
            return
        sess.last_seen_at = datetime.utcnow()
        self.db.commit()

    def logout(self, session_id: str) -> None:
        sess = self.db.get(Session, session_id)
        if sess is None:
            return
        sess.revoked = True
        self.db.commit()

    def revoke_all_sessions(self, user_id: str) -> None:
        self.db.query(Session).filter(Session.user_id == user_id).update(
            {"revoked": True}, synchronize_session=False
        )
        self.db.commit()

    # ---- backfill --------------------------------------------------------

    def _backfill_existing_resources(self, user_id: str) -> None:
        """Assign all unowned (user_id='') rows to this user.

        Runs exactly once, inside the register() transaction when the first
        user is being created. Covers projects, providers, cached workflows,
        and all Agent-private tables (workflow definitions/runs, conversations,
        annotations, evaluations, review states).
        """
        for model in (
            Project, Provider, CachedWorkflow,
            WorkflowDefinition, WorkflowRun, Conversation,
            Annotation, AnnotationEvaluation, AnnotationReviewState,
        ):
            self.db.query(model).filter(model.user_id == "").update(
                {"user_id": user_id}, synchronize_session=False
            )

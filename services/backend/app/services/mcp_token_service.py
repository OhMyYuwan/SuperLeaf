"""MCP access token lifecycle: create, list, verify, revoke.

These tokens let external MCP clients (Codex, Claude Code, VS Code) authenticate
directly against the backend without a browser session cookie. Only the
SHA-256 hash of the token is stored; the plaintext is returned exactly once at
creation time. Verification hashes the presented token and looks up the row,
so a leaked database backup cannot be replayed.

The token format is ``slmcp_<43 url-safe chars>``. The ``slmcp_`` prefix makes
leaked tokens easy to recognize in logs and secret scanners.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ..models import McpToken, User

TOKEN_PREFIX = "slmcp_"
_TOKEN_BYTES = 32  # 32 random bytes -> 43 url-safe base64 chars
MAX_TOKENS_PER_USER = 25
_LAST_USED_THROTTLE_SECONDS = 60  # Only update last_used_at if older than this


def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


class McpTokenError(RuntimeError):
    pass


class McpTokenService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_tokens(self, *, user_id: str) -> list[McpToken]:
        return (
            self.db.query(McpToken)
            .filter(McpToken.user_id == user_id)
            .order_by(McpToken.created_at.desc())
            .all()
        )

    def create_token(
        self,
        *,
        user_id: str,
        name: str = "",
        scope: str = "read",
        expires_in_days: int | None = 30,
    ) -> tuple[McpToken, str]:
        """Create a token. Returns (row, plaintext). Plaintext is not stored."""
        normalized_scope = (scope or "read").strip().lower()
        if normalized_scope not in {"read", "write"}:
            raise McpTokenError("scope must be 'read' or 'write'")

        active_count = (
            self.db.query(McpToken)
            .filter(McpToken.user_id == user_id, McpToken.revoked_at.is_(None))
            .count()
        )
        if active_count >= MAX_TOKENS_PER_USER:
            raise McpTokenError(
                f"Too many active MCP tokens (max {MAX_TOKENS_PER_USER}); revoke one first"
            )

        plaintext = TOKEN_PREFIX + secrets.token_urlsafe(_TOKEN_BYTES)
        expires_at: datetime | None = None
        if expires_in_days:
            expires_at = datetime.utcnow() + timedelta(days=int(expires_in_days))

        row = McpToken(
            user_id=user_id,
            name=(name or "").strip()[:128],
            token_hash=_hash_token(plaintext),
            token_hint=plaintext[-6:],
            scope=normalized_scope,
            expires_at=expires_at,
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row, plaintext

    def revoke_token(self, token_id: str, *, user_id: str) -> bool:
        row = self.db.get(McpToken, token_id)
        if row is None or row.user_id != user_id:
            return False
        if row.revoked_at is None:
            row.revoked_at = datetime.utcnow()
            self.db.commit()
        return True

    def verify_token(self, plaintext: str, *, ip: str = "") -> tuple[User, McpToken] | None:
        """Resolve a presented token to (user, token_row), or None.

        Updates ``last_used_at`` / ``last_used_ip`` on success. Expired or
        revoked tokens, and tokens for disabled/missing users, return None.
        """
        token = (plaintext or "").strip()
        if not token or not token.startswith(TOKEN_PREFIX):
            return None
        row = (
            self.db.query(McpToken)
            .filter(McpToken.token_hash == _hash_token(token))
            .first()
        )
        if row is None or row.revoked_at is not None:
            return None
        if row.expires_at is not None and row.expires_at < datetime.utcnow():
            return None
        user = self.db.get(User, row.user_id)
        if user is None or user.is_disabled:
            return None

        # Throttle last_used_at updates to reduce SQLite write contention.
        # Only update if it's been more than _LAST_USED_THROTTLE_SECONDS since last update.
        now = datetime.utcnow()
        should_update = (
            row.last_used_at is None
            or (now - row.last_used_at).total_seconds() >= _LAST_USED_THROTTLE_SECONDS
        )
        if should_update:
            row.last_used_at = now
            row.last_used_ip = ip or ""
            self.db.commit()

        return user, row


def token_is_active(row: McpToken) -> bool:
    if row.revoked_at is not None:
        return False
    if row.expires_at is not None and row.expires_at < datetime.utcnow():
        return False
    return True

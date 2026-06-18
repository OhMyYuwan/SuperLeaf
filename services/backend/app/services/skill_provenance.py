"""Skill Provenance — tracks whether a skill write is agent-initiated or user-initiated.

Ported from hermes-agent/tools/skill_provenance.py (79 lines).
Uses ContextVar for thread-safe, async-safe write-origin tracking.
"""

from __future__ import annotations

from contextvars import ContextVar, Token

# The sentinel values
FOREGROUND = "foreground"
BACKGROUND_REVIEW = "background_review"

_write_origin: ContextVar[str] = ContextVar("skill_write_origin", default=FOREGROUND)


def set_current_write_origin(origin: str) -> Token:
    """Set the current write origin. Returns a token for reset."""
    return _write_origin.set(origin)


def reset_current_write_origin(token: Token) -> None:
    """Reset the write origin to its previous value."""
    _write_origin.reset(token)


def get_current_write_origin() -> str:
    """Get the current write origin."""
    return _write_origin.get()


def is_background_review() -> bool:
    """Check if the current execution is a background self-improvement review."""
    return _write_origin.get() == BACKGROUND_REVIEW

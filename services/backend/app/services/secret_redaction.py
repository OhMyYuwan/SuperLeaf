"""Utilities for removing secrets before they reach logs, SSE, or UI errors."""

from __future__ import annotations

import re

REDACTION = "[redacted]"

_AUTHORIZATION_BEARER_RE = re.compile(
    r"(\bauthorization\b\s*[:=]\s*[\"']?\s*Bearer\s+)([^\"'\s,;}]+)",
    re.IGNORECASE,
)
_BEARER_RE = re.compile(r"(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})", re.IGNORECASE)
_KEY_VALUE_RE = re.compile(
    r"((?:api[_-]?key|access[_-]?token|refresh[_-]?token|context[_-]?secret|client[_-]?secret|"
    r"password|secret|token)\s*[\"']?\s*[:=]\s*[\"']?)([^\"'\s,;}]+)",
    re.IGNORECASE,
)
_GITHUB_ACCESS_TOKEN_RE = re.compile(r"(x-access-token:)[^@\s]+", re.IGNORECASE)


def redact_secrets(value: object) -> str:
    """Return a display/log-safe string with common secret shapes removed."""
    text = str(value)
    text = _AUTHORIZATION_BEARER_RE.sub(rf"\1{REDACTION}", text)
    text = _BEARER_RE.sub(rf"\1{REDACTION}", text)
    text = _KEY_VALUE_RE.sub(rf"\1{REDACTION}", text)
    text = _GITHUB_ACCESS_TOKEN_RE.sub(rf"\1{REDACTION}", text)
    return text


def safe_error_text(exc: BaseException, *, max_chars: int = 512) -> str:
    """Format an exception without allowing common secrets to escape."""
    return redact_secrets(f"{type(exc).__name__}: {exc}")[:max_chars]

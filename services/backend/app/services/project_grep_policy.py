"""Shared safety policy for project grep regex execution."""

from __future__ import annotations

import re

GREP_MAX_PATTERN_LENGTH = 500
GREP_MAX_DOC_CHARS = 500_000


def validate_grep_pattern(pattern: str) -> str:
    if len(pattern) > GREP_MAX_PATTERN_LENGTH:
        return f"regex pattern too long (max {GREP_MAX_PATTERN_LENGTH} chars)"
    if is_dangerous_regex(pattern):
        return "regex pattern rejected: potential catastrophic backtracking"
    return ""


def is_dangerous_regex(pattern: str) -> bool:
    return bool(
        re.search(r"\([^)]*[+*?][^)]*\)[+*?]", pattern)
        or re.search(r"\[[^\]]*[+*?][^\]]*\][+*?]", pattern)
    )

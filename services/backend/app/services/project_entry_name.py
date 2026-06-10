"""Validation helpers for names stored in a project tree."""

from __future__ import annotations

import re
from pathlib import PurePosixPath, PureWindowsPath

_WINDOWS_DRIVE_PREFIX_RE = re.compile(r"^[A-Za-z]:")


class ProjectEntryNameError(ValueError):
    """Raised when a project tree entry name is unsafe."""


def validate_project_entry_name(name: str, *, field: str = "name") -> str:
    """Return `name` when it is safe to use as one path segment."""
    if name != name.strip():
        raise ProjectEntryNameError(f"{field} must not have leading or trailing whitespace")
    if name in {"", ".", ".."}:
        raise ProjectEntryNameError(f"{field} must not be empty or a dot segment")
    if "/" in name or "\\" in name:
        raise ProjectEntryNameError(f"{field} must not contain path separators")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
        raise ProjectEntryNameError(f"{field} must not contain control characters")
    if (
        PurePosixPath(name).is_absolute()
        or PureWindowsPath(name).is_absolute()
        or _WINDOWS_DRIVE_PREFIX_RE.match(name)
    ):
        raise ProjectEntryNameError(f"{field} must be a relative filename")
    return name

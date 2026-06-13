from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..settings import settings

logger = logging.getLogger(__name__)

ERROR_LEVELS = {"warning", "error", "critical"}


def record_collab_event(
    event: str,
    *,
    level: str = "info",
    project_id: str | None = None,
    doc_id: str | None = None,
    operation: str | None = None,
    code: str | None = None,
    message: str | None = None,
    details: dict[str, Any] | None = None,
    log_dir: Path | None = None,
) -> None:
    """Append a collaboration consistency event to JSONL log files.

    The log intentionally stores IDs, versions, operation names, and error
    codes, but not document text.
    """
    normalized_level = level.lower().strip() or "info"
    payload = {
        "ts": datetime.now(UTC).isoformat(),
        "level": normalized_level,
        "event": event,
    }
    _set_if_present(payload, "project_id", project_id)
    _set_if_present(payload, "doc_id", doc_id)
    _set_if_present(payload, "operation", operation)
    _set_if_present(payload, "code", code)
    _set_if_present(payload, "message", message)
    if details:
        payload["details"] = details

    target_dir = log_dir or settings.data_dir / "logs"
    try:
        _append_jsonl(target_dir / "collaboration.log", payload)
        if normalized_level in ERROR_LEVELS:
            _append_jsonl(target_dir / "collaboration-errors.log", payload)
    except OSError:
        logger.exception("[collab-audit] failed to write collaboration log")


def _set_if_present(payload: dict[str, Any], key: str, value: str | None) -> None:
    if value:
        payload[key] = value


def _append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False, default=str, sort_keys=True))
        f.write("\n")

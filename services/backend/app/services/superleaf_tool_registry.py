"""Shared SuperLeaf tool registry adapters.

The canonical schema lives in services/shared/superleaf-tools.json. Runtime
surfaces convert that schema into their local protocol shape instead of
hand-copying tool definitions.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


def superleaf_openai_tools(names: set[str] | None = None) -> list[dict[str, Any]]:
    """Return OpenAI-compatible function tool definitions."""
    allowed = set(names or [])
    result: list[dict[str, Any]] = []
    for tool in superleaf_tool_registry().get("tools", []):
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "").strip()
        if not name or (allowed and name not in allowed):
            continue
        result.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": str(tool.get("description") or ""),
                    "parameters": tool.get("inputSchema")
                    if isinstance(tool.get("inputSchema"), dict)
                    else {"type": "object", "properties": {}},
                },
            }
        )
    return result


@lru_cache(maxsize=1)
def superleaf_tool_registry() -> dict[str, Any]:
    registry_path = _registry_path()
    with registry_path.open("r", encoding="utf-8") as handle:
        parsed = json.load(handle)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("tools"), list):
        raise ValueError(f"Invalid SuperLeaf tool registry at {registry_path}")
    return parsed


def _registry_path() -> Path:
    return Path(__file__).resolve().parents[3] / "shared" / "superleaf-tools.json"

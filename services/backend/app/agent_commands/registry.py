"""Shared registry loader for SuperLeaf Agent commands."""

from __future__ import annotations

import json
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any

from .context import AgentCommandContext

_MANIFEST_PATH = Path(__file__).resolve().parents[3] / "shared" / "superleaf-tools.json"


@lru_cache(maxsize=1)
def get_agent_command_manifest() -> dict[str, Any]:
    with _MANIFEST_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def get_agent_command_tools() -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    for tool in get_agent_command_manifest().get("tools", []):
        normalized = {
            "name": str(tool.get("name") or ""),
            "description": str(tool.get("description") or ""),
            "inputSchema": deepcopy(tool.get("inputSchema") or {"type": "object", "properties": {}}),
        }
        if isinstance(tool.get("annotations"), dict):
            normalized["annotations"] = deepcopy(tool["annotations"])
        if isinstance(tool.get("_meta"), dict):
            normalized["_meta"] = deepcopy(tool["_meta"])
        tools.append(normalized)
    return tools


def get_agent_command_resources() -> list[dict[str, Any]]:
    return [
        {
            "uri": str(item.get("uri") or ""),
            "name": str(item.get("name") or ""),
            "description": str(item.get("description") or ""),
            "mimeType": str(item.get("mimeType") or "text/plain"),
        }
        for item in get_agent_command_manifest().get("resources", [])
    ]


def get_agent_command_prompts() -> list[dict[str, Any]]:
    return [
        {
            "name": str(prompt.get("name") or ""),
            "description": str(prompt.get("description") or ""),
            "arguments": deepcopy(prompt.get("arguments") or []),
        }
        for prompt in get_agent_command_manifest().get("prompts", [])
    ]


def read_agent_command_resource(uri: str, ctx: AgentCommandContext | None = None) -> dict[str, Any] | None:
    for item in get_agent_command_manifest().get("resources", []):
        if item.get("uri") != uri:
            continue
        mime_type = str(item.get("mimeType") or "text/plain")
        if item.get("kind") == "tools_manifest":
            text = json.dumps(
                {
                    "id": get_agent_command_manifest().get("id"),
                    "version": get_agent_command_manifest().get("version"),
                    "tools": get_agent_command_tools(),
                    "resources": get_agent_command_resources(),
                    "prompts": get_agent_command_prompts(),
                },
                ensure_ascii=False,
            )
        elif item.get("kind") == "current_context":
            text = json.dumps(_current_context_payload(ctx), ensure_ascii=False)
        else:
            text = str(item.get("text") or "")
        return {"contents": [{"uri": uri, "mimeType": mime_type, "text": text}]}
    return None


def _current_context_payload(ctx: AgentCommandContext | None) -> dict[str, Any]:
    if ctx is None:
        return {"status": "no_active_context", "message": "No active SuperLeaf MCP context is available."}
    return {
        "status": "ok",
        "context": {
            "source": str(ctx.source),
            "token_scope": ctx.token_scope,
            "active_project_id": ctx.active_project_id,
            "conversation_id": ctx.conversation_id,
            "document_id": ctx.document_id,
            "metadata_keys": sorted(ctx.metadata.keys()),
        },
    }


def render_agent_command_prompt(name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any] | None:
    values = arguments or {}
    for prompt in get_agent_command_manifest().get("prompts", []):
        if prompt.get("name") != name:
            continue
        messages = []
        for message in prompt.get("messages", []):
            cloned = deepcopy(message)
            content = cloned.get("content")
            if isinstance(content, dict) and isinstance(content.get("text"), str):
                text = content["text"]
                for key, value in values.items():
                    text = text.replace("{{" + str(key) + "}}", str(value))
                content["text"] = text
            messages.append(cloned)
        return {
            "description": str(prompt.get("description") or ""),
            "messages": messages,
        }
    return None

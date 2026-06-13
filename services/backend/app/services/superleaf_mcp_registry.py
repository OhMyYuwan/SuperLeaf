"""Shared SuperLeaf MCP registry loader.

The registry lives outside the backend so Local Agent Host and backend-native
MCP expose the same tool/resource/prompt contract.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


class SuperleafMcpRegistryError(RuntimeError):
    pass


def get_registry_manifest() -> dict[str, Any]:
    manifest = _load_registry()
    return {
        "id": manifest.get("id", "superleaf.tools"),
        "version": manifest.get("version", 1),
        "instructions": manifest.get("instructions") if isinstance(manifest.get("instructions"), dict) else {},
        "tools": get_mcp_tools(),
        "resources": get_mcp_resources(),
        "prompts": get_mcp_prompts(),
    }


def get_mcp_tools() -> list[dict[str, Any]]:
    tools = _load_registry().get("tools")
    if not isinstance(tools, list):
        return []
    out: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "").strip()
        if not name:
            continue
        schema = tool.get("inputSchema")
        out.append(
            {
                "name": name,
                "description": str(tool.get("description") or ""),
                "inputSchema": schema if isinstance(schema, dict) else {"type": "object", "properties": {}},
            }
        )
    return out


def get_mcp_resources() -> list[dict[str, Any]]:
    resources = _load_registry().get("resources")
    if not isinstance(resources, list):
        return []
    out: list[dict[str, Any]] = []
    for resource in resources:
        if not isinstance(resource, dict):
            continue
        uri = str(resource.get("uri") or "").strip()
        name = str(resource.get("name") or "").strip()
        if not uri or not name:
            continue
        out.append(
            {
                "uri": uri,
                "name": name,
                "description": str(resource.get("description") or ""),
                "mimeType": str(resource.get("mimeType") or "text/plain"),
            }
        )
    return out


def get_mcp_prompts() -> list[dict[str, Any]]:
    prompts = _load_registry().get("prompts")
    if not isinstance(prompts, list):
        return []
    out: list[dict[str, Any]] = []
    for prompt in prompts:
        if not isinstance(prompt, dict):
            continue
        name = str(prompt.get("name") or "").strip()
        if not name:
            continue
        raw_args = prompt.get("arguments") if isinstance(prompt.get("arguments"), list) else []
        arguments = [
            {
                "name": str(arg.get("name") or ""),
                "description": str(arg.get("description") or ""),
                "required": bool(arg.get("required")),
            }
            for arg in raw_args
            if isinstance(arg, dict) and str(arg.get("name") or "").strip()
        ]
        out.append(
            {
                "name": name,
                "description": str(prompt.get("description") or ""),
                "arguments": arguments,
            }
        )
    return out


def read_mcp_resource(uri: str) -> dict[str, Any] | None:
    resource = _registry_item("resources", "uri", uri)
    if resource is None:
        return None
    mime_type = str(resource.get("mimeType") or "text/plain")
    return {
        "contents": [
            {
                "uri": str(resource.get("uri") or ""),
                "mimeType": mime_type,
                "text": _resource_text(resource),
            }
        ]
    }


def render_mcp_prompt(name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any] | None:
    prompt = _registry_item("prompts", "name", name)
    if prompt is None:
        return None
    values = arguments if isinstance(arguments, dict) else {}
    messages: list[dict[str, Any]] = []
    for message in prompt.get("messages") if isinstance(prompt.get("messages"), list) else []:
        if not isinstance(message, dict):
            continue
        content = message.get("content") if isinstance(message.get("content"), dict) else {}
        messages.append(
            {
                "role": str(message.get("role") or "user"),
                "content": {
                    "type": str(content.get("type") or "text"),
                    "text": _render_template(str(content.get("text") or ""), values),
                },
            }
        )
    return {
        "description": str(prompt.get("description") or ""),
        "messages": messages,
    }


def mcp_instructions() -> str:
    instructions = _load_registry().get("instructions")
    if not isinstance(instructions, dict):
        return ""
    mcp = instructions.get("mcp")
    if not isinstance(mcp, list):
        return ""
    return " ".join(str(item) for item in mcp if str(item).strip())


def _registry_item(collection: str, key: str, value: str) -> dict[str, Any] | None:
    items = _load_registry().get(collection)
    if not isinstance(items, list):
        return None
    for item in items:
        if isinstance(item, dict) and str(item.get(key) or "") == value:
            return item
    return None


def _resource_text(resource: dict[str, Any]) -> str:
    kind = str(resource.get("kind") or "")
    if kind == "tools_manifest":
        return json.dumps(get_registry_manifest(), ensure_ascii=False, indent=2)
    if kind == "registry_manifest":
        return json.dumps(_load_registry(), ensure_ascii=False, indent=2)
    return str(resource.get("text") or "")


def _render_template(template: str, values: dict[str, Any]) -> str:
    text = template
    for key, value in values.items():
        replacement = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        text = text.replace("{{" + str(key) + "}}", replacement)
    return text


@lru_cache(maxsize=1)
def _load_registry() -> dict[str, Any]:
    path = _registry_path()
    if not path.exists():
        raise SuperleafMcpRegistryError(f"SuperLeaf MCP registry not found: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise SuperleafMcpRegistryError(f"Failed to read SuperLeaf MCP registry {path}: {exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("tools"), list):
        raise SuperleafMcpRegistryError(f"Invalid SuperLeaf MCP registry: {path}")
    return payload


def _registry_path() -> Path:
    return Path(__file__).resolve().parents[3] / "shared" / "superleaf-tools.json"

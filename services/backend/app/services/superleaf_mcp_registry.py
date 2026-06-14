"""Compatibility wrappers for the Agent command registry.

New code should import from ``app.agent_commands.registry``. These names remain
for existing tests and callers while the backend MCP implementation is being
migrated to the protocol/command split.
"""

from __future__ import annotations

from typing import Any

from ..agent_commands.registry import (
    get_agent_command_manifest,
    get_agent_command_prompts,
    get_agent_command_resources,
    get_agent_command_tools,
    read_agent_command_resource,
    render_agent_command_prompt,
)


def get_registry_manifest() -> dict[str, Any]:
    return get_agent_command_manifest()


def get_mcp_tools() -> list[dict[str, Any]]:
    return get_agent_command_tools()


def get_mcp_resources() -> list[dict[str, Any]]:
    return get_agent_command_resources()


def get_mcp_prompts() -> list[dict[str, Any]]:
    return get_agent_command_prompts()


def read_mcp_resource(uri: str) -> dict[str, Any] | None:
    return read_agent_command_resource(uri)


def render_mcp_prompt(name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any] | None:
    return render_agent_command_prompt(name, arguments)

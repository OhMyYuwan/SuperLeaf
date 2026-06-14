"""Shared context/result types for Agent-executable SuperLeaf commands."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any


class AgentCommandSource(StrEnum):
    MCP = "mcp"
    NATIVE_AGENT = "native-agent"
    BROWSER_BRIDGE = "browser-bridge"
    WORKFLOW = "workflow"


@dataclass(frozen=True, slots=True)
class AgentCommandContext:
    source: AgentCommandSource
    user_id: str
    token_id: str = ""
    token_scope: str = "read"
    active_project_id: str = ""
    conversation_id: str = ""
    document_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def can_write(self) -> bool:
        return self.token_scope == "write"

    def with_active_project(self, project_id: str) -> AgentCommandContext:
        return replace(self, active_project_id=project_id)


@dataclass(frozen=True, slots=True)
class AgentCommandResult:
    payload: dict[str, Any]
    next_context: AgentCommandContext
    side_effects: list[dict[str, Any]] = field(default_factory=list)


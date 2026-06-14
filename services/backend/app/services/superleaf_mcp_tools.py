"""Compatibility wrappers for Agent command execution.

New code should use ``app.agent_commands.executor.AgentCommandExecutor``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from typing import Any

from sqlalchemy.orm import Session

from ..agent_commands.context import AgentCommandContext, AgentCommandSource
from ..agent_commands.executor import AgentCommandExecutor
from ..models import McpToken, User


@dataclass(frozen=True, slots=True)
class SuperleafMcpToolContext:
    user: User
    token: McpToken
    active_project_id: str = ""

    @property
    def can_write(self) -> bool:
        return (self.token.scope or "read") == "write"


def call_superleaf_mcp_tool(
    db: Session,
    ctx: SuperleafMcpToolContext,
    name: str,
    arguments: dict[str, Any] | None = None,
) -> tuple[str, SuperleafMcpToolContext]:
    result = AgentCommandExecutor().execute(db, _agent_context(ctx), name, arguments or {})
    next_ctx = replace(ctx, active_project_id=result.next_context.active_project_id)
    return json.dumps(result.payload, ensure_ascii=False), next_ctx


def _agent_context(ctx: SuperleafMcpToolContext) -> AgentCommandContext:
    return AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=ctx.user.id,
        token_id=ctx.token.id,
        token_scope=ctx.token.scope or "read",
        active_project_id=ctx.active_project_id,
    )

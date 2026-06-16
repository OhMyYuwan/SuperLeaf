"""Compatibility wrappers for the backend-native MCP transport.

New code should import from ``app.mcp``. The old names stay stable for callers
that were created before the MCP protocol/Agent command split.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..agent_commands.context import AgentCommandContext, AgentCommandSource
from ..mcp.sessions import McpSessionStore
from ..mcp.transport import MCP_PROTOCOL_VERSION as MCP_PROTOCOL_VERSION
from ..mcp.transport import McpResponse, handle_mcp_request
from .superleaf_mcp_tools import SuperleafMcpToolContext

SuperleafMcpRpcResult = McpResponse
SuperleafMcpSessionStore = McpSessionStore
DEFAULT_MCP_SESSION_STORE = McpSessionStore()


def handle_superleaf_mcp_rpc(
    db: Session,
    ctx: SuperleafMcpToolContext,
    request: dict[str, Any],
    *,
    session_id: str,
    store: McpSessionStore = DEFAULT_MCP_SESSION_STORE,
) -> McpResponse:
    return handle_mcp_request(
        db,
        AgentCommandContext(
            source=AgentCommandSource.MCP,
            user_id=ctx.user.id,
            token_id=ctx.token.id,
            token_scope=(ctx.token.scope or "read").strip().lower(),
            active_project_id=ctx.active_project_id,
        ),
        request,
        session_id=session_id,
        store=store,
    )


def close_superleaf_mcp_session(
    session_id: str,
    store: McpSessionStore = DEFAULT_MCP_SESSION_STORE,
) -> None:
    store.close(session_id)

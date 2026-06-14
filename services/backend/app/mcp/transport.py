"""JSON-RPC transport for the backend-native SuperLeaf MCP server."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..agent_commands.context import AgentCommandContext
from ..agent_commands.executor import AgentCommandExecutor
from ..agent_commands.registry import (
    get_agent_command_prompts,
    get_agent_command_resources,
    get_agent_command_tools,
    read_agent_command_resource,
    render_agent_command_prompt,
)
from .errors import mcp_error, mcp_ok
from .sessions import McpSessionStore

MCP_PROTOCOL_VERSION = "2025-11-25"
logger = logging.getLogger(__name__)


@dataclass(slots=True)
class McpResponse:
    body: dict[str, Any] | None
    status_code: int = 200
    session_id: str = ""


def handle_mcp_request(
    db: Session,
    ctx: AgentCommandContext,
    request: dict[str, Any],
    *,
    session_id: str,
    store: McpSessionStore,
    executor: AgentCommandExecutor | None = None,
) -> McpResponse:
    method = str(request.get("method") or "")
    request_id = request.get("id")
    params = request.get("params") or {}
    if not isinstance(params, dict):
        params = {}
    executor = executor or AgentCommandExecutor()

    if method == "initialize":
        session = store.create()
        return _ok(
            request_id,
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {
                    "tools": {},
                    "resources": {},
                    "prompts": {},
                },
                "serverInfo": {"name": "SuperLeaf", "version": "0.1.0"},
            },
            session_id=session.id,
        )

    if method == "notifications/initialized":
        return McpResponse(body=None, status_code=202, session_id=session_id)

    if not session_id:
        return _error(request_id, -32001, "Missing Mcp-Session-Id", status_code=400)
    session = store.get(session_id)
    if session is None:
        return _error(request_id, -32002, "Unknown or expired MCP session", status_code=404)

    ctx = ctx.with_active_project(session.active_project_id)
    if method == "ping":
        return _ok(request_id, {}, session_id=session.id)
    if method == "tools/list":
        return _ok(request_id, {"tools": get_agent_command_tools()}, session_id=session.id)
    if method == "tools/call":
        name = str(params.get("name") or "")
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            args = {}
        try:
            result = executor.execute(db, ctx, name, args)
            session.active_project_id = result.next_context.active_project_id
            return _ok(
                request_id,
                {"content": [{"type": "text", "text": _json(result.payload)}], "isError": False},
                session_id=session.id,
            )
        except HTTPException as exc:
            return _ok(
                request_id,
                {"content": [{"type": "text", "text": str(exc.detail)}], "isError": True},
                session_id=session.id,
            )
        except Exception as exc:
            logger.exception("Unhandled SuperLeaf MCP tool error")
            return _ok(
                request_id,
                {"content": [{"type": "text", "text": str(exc)}], "isError": True},
                session_id=session.id,
            )
    if method == "resources/list":
        return _ok(request_id, {"resources": get_agent_command_resources()}, session_id=session.id)
    if method == "resources/read":
        resource = read_agent_command_resource(str(params.get("uri") or ""), ctx)
        if resource is None:
            return _error(request_id, -32602, "Resource not found", status_code=404, session_id=session.id)
        return _ok(request_id, resource, session_id=session.id)
    if method == "resources/templates/list":
        return _ok(request_id, {"resourceTemplates": []}, session_id=session.id)
    if method == "prompts/list":
        return _ok(request_id, {"prompts": get_agent_command_prompts()}, session_id=session.id)
    if method == "prompts/get":
        prompt = render_agent_command_prompt(str(params.get("name") or ""), params.get("arguments") or {})
        if prompt is None:
            return _error(request_id, -32602, "Prompt not found", status_code=404, session_id=session.id)
        return _ok(request_id, prompt, session_id=session.id)
    return _error(request_id, -32601, f"Method not found: {method}", status_code=404, session_id=session.id)


def _json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False)


def _ok(request_id: Any, result: dict[str, Any], *, session_id: str) -> McpResponse:
    return McpResponse(body=mcp_ok(request_id, result), status_code=200, session_id=session_id)


def _error(
    request_id: Any,
    code: int,
    message: str,
    *,
    status_code: int,
    session_id: str = "",
) -> McpResponse:
    return McpResponse(
        body=mcp_error(request_id, code, message),
        status_code=status_code,
        session_id=session_id,
    )

"""FastAPI route for the backend-native streamable HTTP MCP endpoint."""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..agent_commands.context import AgentCommandContext, AgentCommandSource
from ..agent_commands.registry import (
    get_agent_command_prompts,
    get_agent_command_resources,
    get_agent_command_tools,
)
from ..api.deps import McpAuthContext, get_mcp_auth
from ..database import get_session
from ..settings import settings
from .errors import mcp_error
from .sessions import McpEventStore, McpSessionStore, McpSseEvent
from .transport import MCP_PROTOCOL_VERSION, handle_mcp_request

router = APIRouter(tags=["mcp-rpc"])
DEFAULT_MCP_SESSION_STORE = McpSessionStore(
    ttl_seconds=settings.mcp_session_ttl_seconds,
    max_sessions=settings.mcp_max_sessions,
)
DEFAULT_MCP_EVENT_STORE = McpEventStore(
    ttl_seconds=settings.mcp_event_ttl_seconds,
    max_per_stream=settings.mcp_event_max_per_stream,
)


@router.get("/mcp/status")
def get_mcp_status(
    ctx: Annotated[McpAuthContext, Depends(get_mcp_auth)],
    mcp_session_id: Annotated[str | None, Header(alias="Mcp-Session-Id")] = None,
) -> dict[str, Any]:
    del ctx
    status = DEFAULT_MCP_SESSION_STORE.status()
    return {
        "status": "ok",
        "service": "superleaf-backend-native-mcp",
        "mcp_url": "/mcp",
        "protocol_version": MCP_PROTOCOL_VERSION,
        "active_session_id": mcp_session_id or "",
        "sessions": status,
        "tool_count": len(get_agent_command_tools()),
        "resource_count": len(get_agent_command_resources()),
        "prompt_count": len(get_agent_command_prompts()),
    }


@router.get("/mcp")
def get_mcp_stream(
    ctx: Annotated[McpAuthContext, Depends(get_mcp_auth)],
    mcp_session_id: Annotated[str | None, Header(alias="Mcp-Session-Id")] = None,
    accept: Annotated[str | None, Header(alias="Accept")] = None,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> Response:
    del ctx
    if "text/event-stream" not in str(accept or ""):
        return JSONResponse(
            mcp_error(None, -32000, "Not Acceptable: Client must accept text/event-stream"),
            status_code=406,
        )
    if not mcp_session_id:
        return JSONResponse(
            mcp_error(None, -32000, "Mcp-Session-Id header is required for GET /mcp"),
            status_code=400,
        )
    session = DEFAULT_MCP_SESSION_STORE.get(mcp_session_id)
    if session is None:
        return JSONResponse(mcp_error(None, -32001, "Session not found"), status_code=404)
    stream_id = _stream_id_for_session(mcp_session_id)
    events: list[McpSseEvent]
    if last_event_id:
        replay_stream_id = DEFAULT_MCP_EVENT_STORE.stream_id_for_event(last_event_id)
        if replay_stream_id != stream_id:
            return JSONResponse(
                mcp_error(None, -32000, "Invalid Last-Event-ID for this MCP session"),
                status_code=400,
            )
        events = DEFAULT_MCP_EVENT_STORE.replay_after(last_event_id)
    else:
        events = [
            DEFAULT_MCP_EVENT_STORE.store_event(
                stream_id,
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/superleaf/stream_ready",
                    "params": {
                        "session_id": mcp_session_id,
                        "tool_count": len(get_agent_command_tools()),
                    },
                },
            )
        ]
    headers = {"Mcp-Protocol-Version": MCP_PROTOCOL_VERSION, "Mcp-Session-Id": mcp_session_id}
    return StreamingResponse(
        _sse_lines(events),
        media_type="text/event-stream",
        headers=headers,
    )


@router.post("/mcp")
async def post_mcp(
    request: Request,
    ctx: Annotated[McpAuthContext, Depends(get_mcp_auth)],
    db: Annotated[Session, Depends(get_session)],
    mcp_session_id: Annotated[str | None, Header(alias="Mcp-Session-Id")] = None,
) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}},
            status_code=400,
        )
    if isinstance(payload, list):
        return _post_mcp_batch(db, _agent_context(ctx), payload, session_id=mcp_session_id or "")
    if not isinstance(payload, dict):
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}},
            status_code=400,
        )
    result = handle_mcp_request(
        db,
        _agent_context(ctx),
        payload,
        session_id=mcp_session_id or "",
        store=DEFAULT_MCP_SESSION_STORE,
    )
    headers = {"Mcp-Protocol-Version": MCP_PROTOCOL_VERSION}
    if result.session_id:
        headers["Mcp-Session-Id"] = result.session_id
    return JSONResponse(result.body, status_code=result.status_code, headers=headers)


def _post_mcp_batch(
    db: Session,
    ctx: AgentCommandContext,
    payload: list[Any],
    *,
    session_id: str,
) -> JSONResponse:
    responses: list[dict[str, Any]] = []
    response_session_id = session_id
    status_code = 200
    for item in payload:
        if not isinstance(item, dict):
            responses.append(mcp_error(None, -32600, "Invalid Request"))
            continue
        result = handle_mcp_request(
            db,
            ctx,
            item,
            session_id=response_session_id,
            store=DEFAULT_MCP_SESSION_STORE,
        )
        if result.session_id:
            response_session_id = result.session_id
        if result.body is not None:
            responses.append(result.body)
        if result.status_code >= 400 and status_code < 400:
            status_code = result.status_code
    headers = {"Mcp-Protocol-Version": MCP_PROTOCOL_VERSION}
    if response_session_id:
        headers["Mcp-Session-Id"] = response_session_id
    if not responses:
        return JSONResponse(None, status_code=202, headers=headers)
    return JSONResponse(responses, status_code=status_code if status_code >= 400 else 200, headers=headers)


@router.delete("/mcp", status_code=204)
def delete_mcp(
    ctx: Annotated[McpAuthContext, Depends(get_mcp_auth)],
    mcp_session_id: Annotated[str | None, Header(alias="Mcp-Session-Id")] = None,
) -> Response:
    del ctx
    if mcp_session_id:
        DEFAULT_MCP_SESSION_STORE.close(mcp_session_id)
    return Response(status_code=204)


def _agent_context(ctx: McpAuthContext) -> AgentCommandContext:
    return AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=ctx.user.id,
        token_id=ctx.token.id,
        token_scope=ctx.scope,
    )


def _stream_id_for_session(session_id: str) -> str:
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:24]
    return f"mcpstream{digest}"


def _sse_lines(events: list[McpSseEvent]):
    for event in events:
        yield "event: message\n"
        yield f"id: {event.id}\n"
        yield f"data: {json.dumps(event.message, ensure_ascii=False)}\n\n"
    yield ": end\n\n"

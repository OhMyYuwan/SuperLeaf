"""JSON-RPC transport for the backend-native SuperLeaf MCP server."""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .superleaf_mcp_registry import (
    get_mcp_prompts,
    get_mcp_resources,
    get_mcp_tools,
    mcp_instructions,
    read_mcp_resource,
    render_mcp_prompt,
)
from .superleaf_mcp_tools import SuperleafMcpToolContext, call_superleaf_mcp_tool


MCP_PROTOCOL_VERSION = "2025-03-26"

_ERR_MISSING_SESSION = -32001
_ERR_UNKNOWN_SESSION = -32002


@dataclass(slots=True)
class SuperleafMcpRpcResult:
    body: dict[str, Any] | list[dict[str, Any]] | None
    session_id: str = ""
    status_code: int = 200


@dataclass(slots=True)
class SuperleafMcpSession:
    id: str
    user_id: str
    token_id: str
    scope: str
    active_project_id: str
    created_at: datetime
    updated_at: datetime
    expires_at: datetime


class SuperleafMcpSessionStore:
    """Small in-memory MCP session store.

    The MCP Streamable HTTP session id carries per-client context such as the
    active project. The bearer token is still verified by the HTTP route on
    every request; this store only preserves MCP conversational state.
    """

    def __init__(self, *, ttl_seconds: int = 3600) -> None:
        self.ttl_seconds = max(60, int(ttl_seconds))
        self._sessions: dict[str, SuperleafMcpSession] = {}
        self._lock = Lock()

    def create(self, ctx: SuperleafMcpToolContext) -> SuperleafMcpSession:
        now = _utcnow()
        with self._lock:
            self._prune_locked(now)
            session_id = self._new_session_id_locked()
            session = SuperleafMcpSession(
                id=session_id,
                user_id=ctx.user.id,
                token_id=ctx.token.id,
                scope=ctx.token.scope or "read",
                active_project_id=ctx.active_project_id,
                created_at=now,
                updated_at=now,
                expires_at=now + timedelta(seconds=self.ttl_seconds),
            )
            self._sessions[session_id] = session
            return session

    def resolve(
        self,
        session_id: str,
        ctx: SuperleafMcpToolContext,
    ) -> SuperleafMcpSession | None:
        now = _utcnow()
        with self._lock:
            self._prune_locked(now)
            session = self._sessions.get(session_id)
            if session is None:
                return None
            if session.user_id != ctx.user.id or session.token_id != ctx.token.id:
                return None
            session.updated_at = now
            session.expires_at = now + timedelta(seconds=self.ttl_seconds)
            return session

    def close(self, session_id: str) -> bool:
        with self._lock:
            return self._sessions.pop(session_id, None) is not None

    def _new_session_id_locked(self) -> str:
        while True:
            session_id = "mcp_" + secrets.token_hex(12)
            if session_id not in self._sessions:
                return session_id

    def _prune_locked(self, now: datetime) -> None:
        expired = [
            session_id
            for session_id, session in self._sessions.items()
            if session.expires_at <= now
        ]
        for session_id in expired:
            self._sessions.pop(session_id, None)


default_superleaf_mcp_session_store = SuperleafMcpSessionStore()


def handle_superleaf_mcp_rpc(
    db: Session,
    ctx: SuperleafMcpToolContext,
    payload: dict[str, Any],
    *,
    session_id: str = "",
    store: SuperleafMcpSessionStore | None = None,
) -> SuperleafMcpRpcResult:
    """Handle one JSON-RPC request object for the SuperLeaf MCP server."""
    session_store = store or default_superleaf_mcp_session_store
    if not isinstance(payload, dict):
        return SuperleafMcpRpcResult(_error_response(None, -32600, "Invalid JSON-RPC request"), status_code=400)

    request_id = payload.get("id")
    method = str(payload.get("method") or "").strip()
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}

    if method == "initialize":
        session = session_store.create(ctx)
        return SuperleafMcpRpcResult(
            _response(request_id, _initialize_result(params)),
            session_id=session.id,
            status_code=200,
        )

    if not session_id:
        return SuperleafMcpRpcResult(
            _error_response(request_id, _ERR_MISSING_SESSION, "Missing Mcp-Session-Id"),
            status_code=400,
        )
    session = session_store.resolve(session_id, ctx)
    if session is None:
        return SuperleafMcpRpcResult(
            _error_response(request_id, _ERR_UNKNOWN_SESSION, "Unknown or expired Mcp-Session-Id"),
            session_id=session_id,
            status_code=404,
        )

    if method == "notifications/initialized":
        if request_id is None:
            return SuperleafMcpRpcResult(None, session_id=session.id, status_code=202)
        return SuperleafMcpRpcResult(_response(request_id, {}), session_id=session.id)
    if method == "ping":
        return SuperleafMcpRpcResult(_response(request_id, {}), session_id=session.id)
    if method == "tools/list":
        return SuperleafMcpRpcResult(_response(request_id, {"tools": get_mcp_tools()}), session_id=session.id)
    if method == "tools/call":
        return _handle_tool_call(db, ctx, request_id, params, session)
    if method == "resources/list":
        return SuperleafMcpRpcResult(
            _response(request_id, {"resources": get_mcp_resources()}),
            session_id=session.id,
        )
    if method == "resources/read":
        return _handle_resource_read(request_id, params, session)
    if method == "resources/templates/list":
        return SuperleafMcpRpcResult(
            _response(request_id, {"resourceTemplates": []}),
            session_id=session.id,
        )
    if method == "prompts/list":
        return SuperleafMcpRpcResult(
            _response(request_id, {"prompts": get_mcp_prompts()}),
            session_id=session.id,
        )
    if method == "prompts/get":
        return _handle_prompt_get(request_id, params, session)

    return SuperleafMcpRpcResult(
        _error_response(request_id, -32601, f"Method not found: {method}"),
        session_id=session.id,
        status_code=200,
    )


def close_superleaf_mcp_session(
    session_id: str,
    *,
    store: SuperleafMcpSessionStore | None = None,
) -> bool:
    return (store or default_superleaf_mcp_session_store).close(session_id)


def _handle_tool_call(
    db: Session,
    ctx: SuperleafMcpToolContext,
    request_id: Any,
    params: dict[str, Any],
    session: SuperleafMcpSession,
) -> SuperleafMcpRpcResult:
    name = str(params.get("name") or "").strip()
    if not name:
        return SuperleafMcpRpcResult(
            _error_response(request_id, -32602, "tools/call params.name is required"),
            session_id=session.id,
            status_code=200,
        )
    raw_arguments = params.get("arguments")
    arguments = raw_arguments if isinstance(raw_arguments, dict) else {}
    tool_ctx = SuperleafMcpToolContext(
        user=ctx.user,
        token=ctx.token,
        active_project_id=session.active_project_id,
    )
    try:
        text, next_ctx = call_superleaf_mcp_tool(db, tool_ctx, name, arguments)
    except HTTPException as exc:
        return SuperleafMcpRpcResult(
            _response(request_id, _tool_text_result(_http_exception_text(exc), is_error=True)),
            session_id=session.id,
            status_code=200,
        )
    except Exception as exc:  # noqa: BLE001
        return SuperleafMcpRpcResult(
            _response(request_id, _tool_text_result(str(exc), is_error=True)),
            session_id=session.id,
            status_code=200,
        )

    session.active_project_id = next_ctx.active_project_id
    return SuperleafMcpRpcResult(
        _response(request_id, _tool_text_result(text, is_error=False)),
        session_id=session.id,
        status_code=200,
    )


def _handle_resource_read(
    request_id: Any,
    params: dict[str, Any],
    session: SuperleafMcpSession,
) -> SuperleafMcpRpcResult:
    uri = str(params.get("uri") or "").strip()
    if not uri:
        return SuperleafMcpRpcResult(
            _error_response(request_id, -32602, "resources/read params.uri is required"),
            session_id=session.id,
        )
    result = read_mcp_resource(uri)
    if result is None:
        return SuperleafMcpRpcResult(
            _error_response(request_id, -32602, f"Resource not found: {uri}"),
            session_id=session.id,
        )
    return SuperleafMcpRpcResult(_response(request_id, result), session_id=session.id)


def _handle_prompt_get(
    request_id: Any,
    params: dict[str, Any],
    session: SuperleafMcpSession,
) -> SuperleafMcpRpcResult:
    name = str(params.get("name") or "").strip()
    if not name:
        return SuperleafMcpRpcResult(
            _error_response(request_id, -32602, "prompts/get params.name is required"),
            session_id=session.id,
        )
    raw_arguments = params.get("arguments")
    arguments = raw_arguments if isinstance(raw_arguments, dict) else {}
    result = render_mcp_prompt(name, arguments)
    if result is None:
        return SuperleafMcpRpcResult(
            _error_response(request_id, -32602, f"Prompt not found: {name}"),
            session_id=session.id,
        )
    return SuperleafMcpRpcResult(_response(request_id, result), session_id=session.id)


def _initialize_result(params: dict[str, Any]) -> dict[str, Any]:
    requested_version = str(params.get("protocolVersion") or MCP_PROTOCOL_VERSION)
    return {
        "protocolVersion": requested_version or MCP_PROTOCOL_VERSION,
        "capabilities": {
            "tools": {"listChanged": False},
            "resources": {"subscribe": False, "listChanged": False},
            "prompts": {"listChanged": False},
        },
        "serverInfo": {
            "name": "SuperLeaf",
            "version": "0.1.0",
        },
        "instructions": mcp_instructions(),
    }


def _tool_text_result(text: str, *, is_error: bool) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": text}],
        "isError": is_error,
    }


def _http_exception_text(exc: HTTPException) -> str:
    detail = exc.detail
    if isinstance(detail, str):
        return detail
    return json.dumps({"status_code": exc.status_code, "detail": detail}, ensure_ascii=False, default=str)


def _response(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error_response(
    request_id: Any,
    code: int,
    message: str,
    data: Any | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def _utcnow() -> datetime:
    return datetime.now(UTC)

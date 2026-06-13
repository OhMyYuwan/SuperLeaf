"""Backend-native MCP endpoint.

This is the canonical SuperLeaf MCP surface for external clients. It uses MCP
bearer tokens, not browser cookies or Local Agent Host bridge context.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..database import get_session
from ..services.superleaf_mcp_tools import SuperleafMcpToolContext
from ..services.superleaf_mcp_transport import (
    MCP_PROTOCOL_VERSION,
    close_superleaf_mcp_session,
    handle_superleaf_mcp_rpc,
)
from .deps import McpAuthContext, get_mcp_auth

router = APIRouter(tags=["mcp-rpc"])


@router.post("/mcp")
async def superleaf_mcp_rpc(
    request: Request,
    mcp_session_id: str | None = Header(default=None, alias="Mcp-Session-Id"),
    auth: McpAuthContext = Depends(get_mcp_auth),
    db: Session = Depends(get_session),
) -> Response:
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(
            _jsonrpc_error(None, -32700, "Parse error"),
            status_code=400,
            headers={"Mcp-Protocol-Version": MCP_PROTOCOL_VERSION},
        )
    if not isinstance(payload, dict):
        return JSONResponse(
            _jsonrpc_error(None, -32600, "Invalid JSON-RPC request"),
            status_code=400,
            headers={"Mcp-Protocol-Version": MCP_PROTOCOL_VERSION},
        )

    ctx = SuperleafMcpToolContext(user=auth.user, token=auth.token)
    result = handle_superleaf_mcp_rpc(
        db,
        ctx,
        payload,
        session_id=(mcp_session_id or "").strip(),
    )
    headers = {"Mcp-Protocol-Version": MCP_PROTOCOL_VERSION}
    if result.session_id:
        headers["Mcp-Session-Id"] = result.session_id
    if result.body is None:
        return Response(status_code=result.status_code, headers=headers)
    return JSONResponse(result.body, status_code=result.status_code, headers=headers)


@router.delete("/mcp", status_code=204)
def close_mcp_session(
    mcp_session_id: str | None = Header(default=None, alias="Mcp-Session-Id"),
    auth: McpAuthContext = Depends(get_mcp_auth),
) -> Response:
    _ = auth
    session_id = (mcp_session_id or "").strip()
    if not session_id:
        raise HTTPException(400, "Missing Mcp-Session-Id")
    close_superleaf_mcp_session(session_id)
    return Response(status_code=204)


def _jsonrpc_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }

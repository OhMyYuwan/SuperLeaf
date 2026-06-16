"""/api/mcp — MCP token management + token-authenticated project access.

Two distinct auth surfaces live here:

1. Token management (``/api/mcp/tokens``) is authenticated by the browser
   session cookie. Users create/list/revoke long-lived MCP tokens here.

2. Data routes (``/api/mcp/projects`` and below) are authenticated by an MCP
   bearer token (``Authorization: Bearer slmcp_...``). These are what an IDE or
   CLI MCP client calls — no browser, no cookie. They give the same read/grep/
   outline access a browser Codex session gets through the bridge, but without
   requiring an open browser tab.

The data routes reuse the exact slicing/grep/outline logic from the native
agent tool kernel so behavior matches the in-browser tools one-for-one.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..agent_commands.context import AgentCommandContext, AgentCommandSource
from ..agent_commands.executor import AgentCommandExecutor
from ..agent_commands.project import GREP_DEFAULT_LIMIT, GREP_HARD_LIMIT
from ..database import get_session
from ..models import User
from ..schemas import (
    McpDocContentOut,
    McpDocOut,
    McpGrepOut,
    McpOutlineOut,
    McpProjectOut,
    McpTokenCreateIn,
    McpTokenCreateOut,
    McpTokenOut,
)
from ..services.mcp_token_service import McpTokenError, McpTokenService, token_is_active
from .deps import McpAuthContext, get_current_user, get_mcp_auth

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


def _token_out(row) -> McpTokenOut:
    out = McpTokenOut.model_validate(row, from_attributes=True)
    out.is_active = token_is_active(row)
    return out


# ---------------------------------------------------------------------------
# Token management (session-cookie authenticated)
# ---------------------------------------------------------------------------


@router.get("/tokens", response_model=list[McpTokenOut])
def list_mcp_tokens(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[McpTokenOut]:
    rows = McpTokenService(db).list_tokens(user_id=user.id)
    return [_token_out(row) for row in rows]


@router.post("/tokens", response_model=McpTokenCreateOut, status_code=201)
def create_mcp_token(
    body: McpTokenCreateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> McpTokenCreateOut:
    try:
        row, plaintext = McpTokenService(db).create_token(
            user_id=user.id,
            name=body.name,
            scope=body.scope,
            expires_in_days=body.expires_in_days,
        )
    except McpTokenError as exc:
        raise HTTPException(400, str(exc)) from exc
    return McpTokenCreateOut(token=_token_out(row), plaintext=plaintext)


@router.delete("/tokens/{token_id}", status_code=204)
def revoke_mcp_token(
    token_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> None:
    ok = McpTokenService(db).revoke_token(token_id, user_id=user.id)
    if not ok:
        raise HTTPException(404, "Token not found")


# ---------------------------------------------------------------------------
# Token-authenticated data routes (IDE/CLI MCP clients)
# ---------------------------------------------------------------------------


@router.get("/whoami")
def mcp_whoami(ctx: McpAuthContext = Depends(get_mcp_auth)) -> dict:
    """Identify the user + scope behind the presented MCP token."""
    return {
        "user_id": ctx.user.id,
        "display_name": ctx.user.display_name or ctx.user.email,
        "email": ctx.user.email,
        "scope": ctx.scope,
        "token_id": ctx.token.id,
        "token_name": ctx.token.name,
    }


@router.get("/projects", response_model=list[McpProjectOut])
def mcp_list_projects(
    project_type: str = Query(default="all"),
    ctx: McpAuthContext = Depends(get_mcp_auth),
    db: Session = Depends(get_session),
) -> list[McpProjectOut]:
    """List projects the token's owner can access (owned + shared)."""
    result = _execute_agent_command(
        db,
        ctx,
        "superleaf_list_projects",
        {"project_type": project_type},
    )
    return [McpProjectOut(**item) for item in result["projects"]]


@router.get("/projects/{project_id}/docs", response_model=list[McpDocOut])
def mcp_list_docs(
    project_id: str,
    ctx: McpAuthContext = Depends(get_mcp_auth),
    db: Session = Depends(get_session),
) -> list[McpDocOut]:
    result = _execute_agent_command(db, ctx, "project_list_docs", {"project_id": project_id})
    return [McpDocOut(**item) for item in result["docs"]]


@router.get("/projects/{project_id}/docs/{doc_id}", response_model=McpDocContentOut)
def mcp_read_doc(
    project_id: str,
    doc_id: str,
    range_start: int = Query(default=0, ge=0),
    range_end: int | None = Query(default=None, ge=0),
    ctx: McpAuthContext = Depends(get_mcp_auth),
    db: Session = Depends(get_session),
) -> McpDocContentOut:
    result = _execute_agent_command(
        db,
        ctx,
        "project_read_doc",
        {
            "project_id": project_id,
            "doc_id": doc_id,
            "range_start": range_start,
            "range_end": range_end,
        },
    )
    return McpDocContentOut(**result)


@router.get("/projects/{project_id}/grep", response_model=McpGrepOut)
def mcp_grep(
    project_id: str,
    pattern: str = Query(..., min_length=1),
    format: str = Query(default=""),
    max_results: int = Query(default=GREP_DEFAULT_LIMIT, ge=1, le=GREP_HARD_LIMIT),
    ctx: McpAuthContext = Depends(get_mcp_auth),
    db: Session = Depends(get_session),
) -> McpGrepOut:
    result = _execute_agent_command(
        db,
        ctx,
        "project_grep",
        {
            "project_id": project_id,
            "pattern": pattern,
            "format": format,
            "max_results": max_results,
        },
    )
    return McpGrepOut(**result)


@router.get("/projects/{project_id}/docs/{doc_id}/outline", response_model=McpOutlineOut)
def mcp_outline(
    project_id: str,
    doc_id: str,
    ctx: McpAuthContext = Depends(get_mcp_auth),
    db: Session = Depends(get_session),
) -> McpOutlineOut:
    result = _execute_agent_command(
        db,
        ctx,
        "project_outline",
        {"project_id": project_id, "doc_id": doc_id},
    )
    return McpOutlineOut(**result)


def _execute_agent_command(
    db: Session,
    ctx: McpAuthContext,
    name: str,
    args: dict,
) -> dict:
    command_ctx = AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=ctx.user.id,
        token_id=ctx.token.id,
        token_scope=ctx.scope,
    )
    return AgentCommandExecutor().execute(db, command_ctx, name, args).payload

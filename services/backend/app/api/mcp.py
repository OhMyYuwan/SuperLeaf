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

import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Doc, Project, User
from ..schemas import (
    McpDocContentOut,
    McpDocOut,
    McpGrepHit,
    McpGrepOut,
    McpOutlineOut,
    McpOutlineSection,
    McpProjectOut,
    McpTokenCreateIn,
    McpTokenCreateOut,
    McpTokenOut,
)
from ..services.mcp_token_service import McpTokenError, McpTokenService, token_is_active
from ..services.native_agent_tool_kernel import _extract_outline
from ..services.project_member_service import ProjectMemberService
from ..services.project_service import ProjectService
from .deps import McpAuthContext, get_current_user, get_mcp_auth

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


def _is_dangerous_regex(pattern: str) -> bool:
    """Heuristic check for catastrophic backtracking patterns (ReDoS).

    Rejects patterns with nested quantifiers that can cause exponential
    backtracking on long strings: (a+)+, (a*)+, (a+)*, (a|a)+, etc.
    This is a conservative heuristic; it may reject some safe patterns.
    """
    # Reject nested quantifiers: +/*/? immediately following a closing paren or bracket
    # that itself contains a quantifier
    danger_patterns = [
        r"\([^)]*[+*?][^)]*\)[+*?]",  # (...)+ or (...)* or (...)?*
        r"\[[^\]]*[+*?][^\]]*\][+*?]",  # [...]+ or ...
    ]
    for danger in danger_patterns:
        if re.search(danger, pattern):
            return True
    return False

# Mirror the native agent tool kernel limits so MCP and in-browser tools behave
# identically.
_READ_LIMIT = 20_000
_GREP_DEFAULT_LIMIT = 50
_GREP_HARD_LIMIT = 200
_GREP_PREVIEW_CHARS = 240
_GREP_MAX_PATTERN_LENGTH = 500  # Reject overly complex regex patterns
_GREP_MAX_DOC_CHARS = 500_000  # Skip documents exceeding this size (ReDoS mitigation)
_LIST_LIMIT = 500


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
    user = ctx.user
    type_filter = (project_type or "all").strip().lower()
    svc = ProjectService(db)
    member_svc = ProjectMemberService(db)

    pairs: list[tuple[Project, str]] = [(p, "owner") for p in svc.list(user_id=user.id)]
    for project, member in member_svc.list_shared_projects(user.id):
        pairs.append((project, member.role))

    out: list[McpProjectOut] = []
    for project, role in pairs:
        if type_filter not in ("all", "") and (project.project_type or "paper") != type_filter:
            continue
        out.append(
            McpProjectOut(
                id=project.id,
                name=project.name,
                project_type=project.project_type or "paper",
                my_role=role,
                main_doc_id=project.main_doc_id or "",
                updated_at=project.updated_at,
            )
        )
    return out


def _require_project_access(db: Session, project_id: str, user_id: str) -> Project:
    project = db.get(Project, project_id)
    if project is None or not ProjectMemberService(db).has_access(project_id, user_id):
        # 404 (not 403) so a token cannot probe foreign project ids.
        raise HTTPException(404, "Project not found")
    return project


@router.get("/projects/{project_id}/docs", response_model=list[McpDocOut])
def mcp_list_docs(
    project_id: str,
    ctx: McpAuthContext = Depends(get_mcp_auth),
    db: Session = Depends(get_session),
) -> list[McpDocOut]:
    _require_project_access(db, project_id, ctx.user.id)
    rows = (
        db.query(Doc.id, Doc.name, Doc.format, Doc.folder_id, Doc.updated_at)
        .filter(Doc.project_id == project_id)
        .order_by(Doc.name.asc())
        .limit(_LIST_LIMIT)
        .all()
    )
    return [
        McpDocOut(
            id=r.id,
            name=r.name,
            format=r.format,
            folder_id=r.folder_id or "",
            updated_at=r.updated_at,
        )
        for r in rows
    ]


@router.get("/projects/{project_id}/docs/{doc_id}", response_model=McpDocContentOut)
def mcp_read_doc(
    project_id: str,
    doc_id: str,
    range_start: int = Query(default=0, ge=0),
    range_end: int | None = Query(default=None, ge=0),
    ctx: McpAuthContext = Depends(get_mcp_auth),
    db: Session = Depends(get_session),
) -> McpDocContentOut:
    _require_project_access(db, project_id, ctx.user.id)
    doc = db.get(Doc, doc_id)
    if doc is None or doc.project_id != project_id:
        raise HTTPException(404, "doc not found in this project")
    content = doc.content or ""
    total = len(content)
    start = max(0, min(range_start, total))
    end = total if range_end is None else max(start, min(range_end, total))
    if end - start > _READ_LIMIT:
        end = start + _READ_LIMIT
    return McpDocContentOut(
        doc_id=doc.id,
        name=doc.name,
        format=doc.format,
        total_length=total,
        range_start=start,
        range_end=end,
        content=content[start:end],
        truncated=end < total or start > 0,
    )


@router.get("/projects/{project_id}/grep", response_model=McpGrepOut)
def mcp_grep(
    project_id: str,
    pattern: str = Query(..., min_length=1),
    format: str = Query(default=""),
    max_results: int = Query(default=_GREP_DEFAULT_LIMIT, ge=1, le=_GREP_HARD_LIMIT),
    ctx: McpAuthContext = Depends(get_mcp_auth),
    db: Session = Depends(get_session),
) -> McpGrepOut:
    _require_project_access(db, project_id, ctx.user.id)

    # ReDoS mitigation: reject overly long or complex patterns
    if len(pattern) > _GREP_MAX_PATTERN_LENGTH:
        raise HTTPException(400, f"regex pattern too long (max {_GREP_MAX_PATTERN_LENGTH} chars)")

    # Heuristic check for catastrophic backtracking patterns
    if _is_dangerous_regex(pattern):
        raise HTTPException(400, "regex pattern rejected: potential catastrophic backtracking")

    try:
        regex = re.compile(pattern, re.MULTILINE)
    except re.error as exc:
        raise HTTPException(400, f"invalid regex: {exc}") from exc
    format_filter = (format or "").strip().lower()
    q = db.query(Doc.id, Doc.name, Doc.format, Doc.content).filter(
        Doc.project_id == project_id
    )
    if format_filter:
        q = q.filter(Doc.format == format_filter)
    rows = q.all()

    hits: list[McpGrepHit] = []
    for row in rows:
        content = row.content or ""
        # ReDoS mitigation: skip excessively large documents
        if len(content) > _GREP_MAX_DOC_CHARS:
            continue
        for m in regex.finditer(content):
            line_start = content.rfind("\n", 0, m.start()) + 1
            line_end = content.find("\n", m.end())
            line_end = len(content) if line_end == -1 else line_end
            line_no = content.count("\n", 0, m.start()) + 1
            preview = content[line_start:line_end]
            if len(preview) > _GREP_PREVIEW_CHARS:
                cut_at = max(0, m.start() - line_start - 60)
                preview = preview[cut_at : cut_at + _GREP_PREVIEW_CHARS]
            hits.append(
                McpGrepHit(
                    doc_id=row.id,
                    doc_name=row.name,
                    format=row.format,
                    offset=m.start(),
                    line=line_no,
                    preview=preview,
                )
            )
            if len(hits) >= max_results:
                break
        if len(hits) >= max_results:
            break
    return McpGrepOut(hits=hits, truncated=len(hits) >= max_results)


@router.get("/projects/{project_id}/docs/{doc_id}/outline", response_model=McpOutlineOut)
def mcp_outline(
    project_id: str,
    doc_id: str,
    ctx: McpAuthContext = Depends(get_mcp_auth),
    db: Session = Depends(get_session),
) -> McpOutlineOut:
    _require_project_access(db, project_id, ctx.user.id)
    doc = db.get(Doc, doc_id)
    if doc is None or doc.project_id != project_id:
        raise HTTPException(404, "doc not found in this project")
    fmt = (doc.format or "").lower()
    sections = _extract_outline(doc.content or "", fmt)
    return McpOutlineOut(
        doc_id=doc.id,
        name=doc.name,
        format=fmt,
        sections=[
            McpOutlineSection(
                level=int(s.get("level", 3)),
                title=str(s.get("title", "")),
                offset=int(s.get("offset", 0)),
            )
            for s in sections
        ],
    )

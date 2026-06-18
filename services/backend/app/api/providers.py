"""/api/providers routes — register, list, activate, probe, rotate, delete.

Per-user: every endpoint requires a logged-in user and operates only on
providers owned by that user. The "at most one active provider" invariant is
also per-user (different users can have independent active providers).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Provider, User
from ..schemas import (
    AgentStatOut,
    BrowserCodexAgentSyncIn,
    BrowserClaudeAgentSyncIn,
    BrowserNanobotModelSyncIn,
    ProviderIn,
    ProviderModelOut,
    ProviderOut,
    ProviderStatsOut,
    ProviderUpdate,
)
from ..services import stats_service
from ..services.provider_service import ProviderService
from .deps import get_current_user

router = APIRouter(prefix="/api/providers", tags=["providers"])


def _to_out(p: Provider) -> ProviderOut:
    return ProviderOut(
        id=p.id,
        name=p.name,
        kind=p.kind,
        endpoint=p.endpoint,
        status=p.status,
        status_detail=p.status_detail,
        is_active=p.is_active,
        meta=p.meta or {},
        created_at=p.created_at,
        updated_at=p.updated_at,
        has_api_key=bool(p.api_key_enc),
    )


@router.get("", response_model=list[ProviderOut])
def list_providers(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[ProviderOut]:
    return [_to_out(p) for p in ProviderService(db).list_providers(user_id=user.id)]


@router.post("", response_model=ProviderOut, status_code=201)
def create_provider(
    body: ProviderIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProviderOut:
    svc = ProviderService(db)
    p = svc.create(
        user_id=user.id,
        name=body.name,
        kind=body.kind,
        endpoint=body.endpoint,
        api_key=body.api_key,
        activate=body.activate,
        transport=body.transport,
        workspace_path=body.workspace_path,
        codex_model=body.codex_model,
        codex_effort=body.codex_effort,
        codex_summary=body.codex_summary,
        codex_service_tier=body.codex_service_tier,
        codex_sandbox=body.codex_sandbox,
        codex_approval_policy=body.codex_approval_policy,
        codex_prompt_mode=body.codex_prompt_mode,
        codex_tool_mode=body.codex_tool_mode,
        codex_context_mode=body.codex_context_mode,
        claude_model=body.claude_model,
        claude_prompt_mode=body.claude_prompt_mode,
        claude_tool_mode=body.claude_tool_mode,
    )
    return _to_out(p)


@router.patch("/{provider_id}", response_model=ProviderOut)
def update_provider(
    provider_id: str,
    body: ProviderUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProviderOut:
    svc = ProviderService(db)
    try:
        p = svc.update(
            provider_id,
            user_id=user.id,
            name=body.name,
            endpoint=body.endpoint,
            api_key=body.api_key,
            transport=body.transport,
            workspace_path=body.workspace_path,
            codex_model=body.codex_model,
            codex_effort=body.codex_effort,
            codex_summary=body.codex_summary,
            codex_service_tier=body.codex_service_tier,
            codex_sandbox=body.codex_sandbox,
            codex_approval_policy=body.codex_approval_policy,
            codex_prompt_mode=body.codex_prompt_mode,
            codex_tool_mode=body.codex_tool_mode,
            codex_context_mode=body.codex_context_mode,
            claude_model=body.claude_model,
            claude_prompt_mode=body.claude_prompt_mode,
            claude_tool_mode=body.claude_tool_mode,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if p is None:
        raise HTTPException(404, "Provider not found")
    return _to_out(p)


@router.delete("/{provider_id}", status_code=204)
def delete_provider(
    provider_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> None:
    if not ProviderService(db).delete(provider_id, user_id=user.id):
        raise HTTPException(404, "Provider not found")


@router.post("/{provider_id}/activate", response_model=ProviderOut)
def activate_provider(
    provider_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProviderOut:
    p = ProviderService(db).activate(provider_id, user_id=user.id)
    if p is None:
        raise HTTPException(404, "Provider not found")
    return _to_out(p)


@router.post("/{provider_id}/probe", response_model=ProviderOut)
async def probe_provider(
    provider_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProviderOut:
    p = await ProviderService(db).probe(provider_id, user_id=user.id)
    if p is None:
        raise HTTPException(404, "Provider not found")
    return _to_out(p)


@router.get("/{provider_id}/models", response_model=list[ProviderModelOut])
async def list_provider_models(
    provider_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[ProviderModelOut]:
    try:
        rows = await ProviderService(db).list_models(provider_id, user_id=user.id)
    except Exception as exc:
        raise HTTPException(502, f"Model scan failed: {type(exc).__name__}: {str(exc)[:240]}") from exc
    if rows is None:
        raise HTTPException(404, "Provider not found")
    return [ProviderModelOut(**row) for row in rows]


@router.post("/{provider_id}/browser-nanobot-models", response_model=ProviderOut)
def sync_browser_nanobot_models(
    provider_id: str,
    body: BrowserNanobotModelSyncIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProviderOut:
    try:
        p = ProviderService(db).sync_browser_nanobot_models(
            provider_id,
            user_id=user.id,
            provider_name=body.provider_name,
            models=[row.model_dump() for row in body.models],
            local_agent_host_endpoint=body.local_agent_host_endpoint,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if p is None:
        raise HTTPException(404, "Provider not found")
    return _to_out(p)


@router.post("/{provider_id}/browser-codex-agent", response_model=ProviderOut)
def sync_browser_codex_agent(
    provider_id: str,
    body: BrowserCodexAgentSyncIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProviderOut:
    try:
        p = ProviderService(db).sync_browser_codex_agent(
            provider_id,
            user_id=user.id,
            health=body.health,
            models=[row.model_dump() for row in body.models],
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if p is None:
        raise HTTPException(404, "Provider not found")
    return _to_out(p)


@router.post("/{provider_id}/browser-claude-agent", response_model=ProviderOut)
def sync_browser_claude_agent(
    provider_id: str,
    body: BrowserClaudeAgentSyncIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProviderOut:
    try:
        p = ProviderService(db).sync_browser_claude_agent(
            provider_id,
            user_id=user.id,
            health=body.health,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if p is None:
        raise HTTPException(404, "Provider not found")
    return _to_out(p)


@router.get("/{provider_id}/stats", response_model=ProviderStatsOut)
def provider_stats(
    provider_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProviderStatsOut:
    """Per-agent usage stats for a provider (V3 task 3.4)."""
    provider = ProviderService(db).get(provider_id, user_id=user.id)
    if provider is None:
        raise HTTPException(404, "Provider not found")
    rows = stats_service.stats_for_provider(db, provider_id, user_id=provider.user_id)
    return ProviderStatsOut(
        provider_id=provider_id,
        agents=[
            AgentStatOut(
                workflow_id=r.workflow_id,
                workflow_name=r.workflow_name,
                runs=r.runs,
                accepts=r.accepts,
                rejects=r.rejects,
                accept_rate=r.accept_rate,
                avg_latency_ms=r.avg_latency_ms,
            )
            for r in rows
        ],
    )

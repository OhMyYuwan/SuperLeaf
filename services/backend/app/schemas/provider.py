"""Provider 与浏览器 Agent 同步相关 schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    kind: str = Field(
        pattern="^(dify-local|dify-cloud|claude-direct|claude-local|nanobot|native|codex-local)$"
    )
    endpoint: str = Field(min_length=1, max_length=512)
    api_key: str = Field(min_length=1, max_length=1024)
    activate: bool = False
    transport: str | None = Field(default=None, pattern="^(backend|browser)$")
    workspace_path: str | None = Field(default=None, max_length=2048)
    codex_model: str | None = Field(default=None, max_length=128)
    codex_effort: str | None = Field(default=None, pattern="^(none|minimal|low|medium|high|xhigh)$")
    codex_summary: str | None = Field(default=None, pattern="^(none|auto|concise|detailed)$")
    codex_service_tier: str | None = Field(default=None, max_length=64)
    codex_sandbox: str | None = Field(
        default=None,
        pattern="^(read-only|workspace-write|danger-full-access)$",
    )
    codex_approval_policy: str | None = Field(
        default=None,
        pattern="^(never|untrusted|on-request|on-failure)$",
    )
    codex_prompt_mode: str | None = Field(default=None, pattern="^(fast-edit|full-agent)$")
    codex_tool_mode: str | None = Field(default=None, pattern="^(mcp-first|browser-preflight|marker-only)$")
    codex_context_mode: str | None = Field(default=None, pattern="^(legacy-blocks|lease)$")
    claude_model: str | None = Field(default=None, max_length=128)
    claude_prompt_mode: str | None = Field(default=None, pattern="^(fast-edit|full-agent)$")
    claude_tool_mode: str | None = Field(default=None, pattern="^(mcp-first|browser-preflight|marker-only)$")


class ProviderUpdate(BaseModel):
    name: str | None = None
    endpoint: str | None = None
    api_key: str | None = None  # empty/None means "don't rotate"
    transport: str | None = Field(default=None, pattern="^(backend|browser)$")
    workspace_path: str | None = Field(default=None, max_length=2048)
    codex_model: str | None = Field(default=None, max_length=128)
    codex_effort: str | None = Field(default=None, pattern="^(none|minimal|low|medium|high|xhigh)$")
    codex_summary: str | None = Field(default=None, pattern="^(none|auto|concise|detailed)$")
    codex_service_tier: str | None = Field(default=None, max_length=64)
    codex_sandbox: str | None = Field(
        default=None,
        pattern="^(read-only|workspace-write|danger-full-access)$",
    )
    codex_approval_policy: str | None = Field(
        default=None,
        pattern="^(never|untrusted|on-request|on-failure)$",
    )
    codex_prompt_mode: str | None = Field(default=None, pattern="^(fast-edit|full-agent)$")
    codex_tool_mode: str | None = Field(default=None, pattern="^(mcp-first|browser-preflight|marker-only)$")
    codex_context_mode: str | None = Field(default=None, pattern="^(legacy-blocks|lease)$")
    claude_model: str | None = Field(default=None, max_length=128)
    claude_prompt_mode: str | None = Field(default=None, pattern="^(fast-edit|full-agent)$")
    claude_tool_mode: str | None = Field(default=None, pattern="^(mcp-first|browser-preflight|marker-only)$")


class ProviderOut(BaseModel):
    id: str
    name: str
    kind: str
    endpoint: str
    status: str
    status_detail: str
    is_active: bool
    meta: dict
    created_at: datetime
    updated_at: datetime
    # Never return api_key. We only signal whether one exists.
    has_api_key: bool

    class Config:
        from_attributes = True


class ProviderModelOut(BaseModel):
    id: str
    name: str
    description: str = ""


class BrowserNanobotModelIn(BaseModel):
    id: str = Field(min_length=1, max_length=512)
    name: str = Field(default="", max_length=512)
    description: str = Field(default="", max_length=2048)
    raw: dict = Field(default_factory=dict)


class BrowserNanobotModelSyncIn(BaseModel):
    provider_name: str = ""
    models: list[BrowserNanobotModelIn]
    local_agent_host_endpoint: str = Field(default="", max_length=1024)


class BrowserCodexModelIn(BaseModel):
    id: str = Field(min_length=1, max_length=512)
    model: str = Field(default="", max_length=512)
    name: str = Field(default="", max_length=512)
    description: str = Field(default="", max_length=2048)
    hidden: bool = False
    is_default: bool = False
    default_reasoning_effort: str = Field(default="", max_length=64)
    supported_reasoning_efforts: list[str] = Field(default_factory=list)
    service_tiers: list[dict] = Field(default_factory=list)
    default_service_tier: str = Field(default="", max_length=128)
    raw: dict = Field(default_factory=dict)


class BrowserCodexAgentSyncIn(BaseModel):
    health: dict = Field(default_factory=dict)
    models: list[BrowserCodexModelIn] = Field(default_factory=list)


class BrowserClaudeAgentSyncIn(BaseModel):
    health: dict = Field(default_factory=dict)


class CachedWorkflowOut(BaseModel):
    id: str
    provider_id: str
    external_id: str
    name: str
    description: str
    kind: str
    tags: list[str]
    last_synced_at: datetime
    is_disabled: bool = False

    class Config:
        from_attributes = True

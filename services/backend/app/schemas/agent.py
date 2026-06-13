"""原生 Agent 凭证与 Agent 定义 schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from .skill import NativeAgentSkillRecipeIn


class NativeAgentCredentialIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    base_url: str = Field(min_length=1, max_length=512)
    api_key: str = Field(min_length=1, max_length=1024)
    runtime_kind: str = Field(default="openai-agents-sdk", max_length=64)
    default_model: str = Field(default="", max_length=128)


class NativeAgentCredentialPatch(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    runtime_kind: str | None = None
    default_model: str | None = None


class NativeAgentCredentialOut(BaseModel):
    id: str
    user_id: str
    name: str
    base_url: str
    runtime_kind: str
    default_model: str
    status: str
    status_detail: str
    meta: dict
    created_at: datetime
    updated_at: datetime
    has_api_key: bool

    class Config:
        from_attributes = True


class AgentWorkspaceFileOut(BaseModel):
    path: str
    type: str
    size: int = 0


class NativeAgentIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str = ""
    provider_id: str = ""
    model: str = Field(default="", max_length=128)
    instructions: str = ""
    agent_md: str = ""
    skill_ids: list[str] = Field(default_factory=list)
    skill_recipes: list[NativeAgentSkillRecipeIn] = Field(default_factory=list)
    output_contract: str = Field(default="annotation", pattern="^(annotation|plan|workflow|freeform)$")
    runtime_config: dict = Field(default_factory=dict)
    is_enabled: bool = True


class NativeAgentPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    provider_id: str | None = None
    model: str | None = None
    instructions: str | None = None
    agent_md: str | None = None
    skill_ids: list[str] | None = None
    skill_recipes: list[NativeAgentSkillRecipeIn] | None = None
    output_contract: str | None = Field(default=None, pattern="^(annotation|plan|workflow|freeform)$")
    runtime_config: dict | None = None
    is_enabled: bool | None = None


class NativeAgentOut(BaseModel):
    id: str
    project_id: str
    owner_user_id: str
    provider_id: str
    name: str
    description: str
    model: str
    instructions: str
    agent_md: str
    skill_ids: list[str]
    workspace_path: str
    setup_status: str
    setup_log: str
    output_contract: str
    runtime_config: dict
    is_enabled: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

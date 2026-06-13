"""MCP server 配置、执行策略与 MCP 访问 token schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class McpServerConfigIn(BaseModel):
    id: str = Field(default="", max_length=128)
    name: str = Field(default="", max_length=256)
    enabled: bool = True
    transport: str = Field(default="remote", max_length=64)
    endpoint: str = Field(default="", max_length=512)
    command: str = Field(default="", max_length=512)
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    allowed_tools: list[str] = Field(default_factory=list)


class NativeMcpServerIn(BaseModel):
    preset_id: str = Field(default="", max_length=128)
    source: str = Field(default="custom", pattern="^(catalog|custom)$")
    name: str = Field(default="", max_length=128)
    description: str = ""
    transport: str = Field(default="remote", max_length=32)
    endpoint: str = Field(default="", max_length=512)
    command: str = Field(default="", max_length=256)
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    allowed_tools: list[str] = Field(default_factory=list)
    is_enabled: bool = True


class NativeMcpServerPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    transport: str | None = None
    endpoint: str | None = None
    command: str | None = None
    args: list[str] | None = None
    env: dict[str, str] | None = None
    allowed_tools: list[str] | None = None
    is_enabled: bool | None = None


class NativeMcpServerOut(BaseModel):
    id: str
    user_id: str
    preset_id: str
    source: str
    name: str
    description: str
    transport: str
    endpoint: str = ""
    command: str
    args: list[str]
    env_keys: list[str] = Field(default_factory=list)
    allowed_tools: list[str]
    is_enabled: bool
    status: str
    status_detail: str
    last_probe_at: datetime | None = None
    last_probe_status: str = ""
    last_probe_detail: str = ""
    last_golden_at: datetime | None = None
    last_golden_status: str = ""
    last_golden_detail: str = ""
    last_tool_count: int = 0
    created_at: datetime
    updated_at: datetime


class McpExecutionPolicyOut(BaseModel):
    remote_enabled: bool
    stdio_enabled: bool
    inline_config_enabled: bool
    remote_private_networks_enabled: bool
    allowed_transports: list[str] = Field(default_factory=list)


class McpProbeIn(BaseModel):
    preset_id: str = Field(default="", max_length=256)
    server: McpServerConfigIn | None = None
    env: dict[str, str] = Field(default_factory=dict)
    allowed_tools: list[str] | None = None


class McpGoldenTestIn(BaseModel):
    preset_id: str = Field(min_length=1, max_length=256)
    test_id: str = Field(default="", max_length=256)
    server: McpServerConfigIn | None = None
    env: dict[str, str] = Field(default_factory=dict)


class McpTokenCreateIn(BaseModel):
    name: str = Field(default="", max_length=128)
    # 'read' | 'write'
    scope: str = Field(default="read")
    # Days until expiry; 0 / None means no expiry.
    expires_in_days: int | None = Field(default=30, ge=0, le=365)

    @field_validator("scope")
    @classmethod
    def _check_scope(cls, value: str) -> str:
        normalized = (value or "read").strip().lower()
        if normalized not in {"read", "write"}:
            raise ValueError("scope must be 'read' or 'write'")
        return normalized


class McpTokenOut(BaseModel):
    id: str
    name: str
    scope: str
    token_hint: str
    created_at: datetime
    expires_at: datetime | None = None
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None
    is_active: bool = True

    class Config:
        from_attributes = True


class McpTokenCreateOut(BaseModel):
    """Returned exactly once on creation; carries the plaintext token."""

    token: McpTokenOut
    plaintext: str


class McpProjectOut(BaseModel):
    id: str
    name: str
    project_type: str
    my_role: str
    main_doc_id: str = ""
    updated_at: datetime


class McpDocOut(BaseModel):
    id: str
    name: str
    format: str
    folder_id: str = ""
    updated_at: datetime | None = None


class McpDocContentOut(BaseModel):
    doc_id: str
    name: str
    format: str
    total_length: int
    range_start: int
    range_end: int
    content: str
    truncated: bool


class McpGrepHit(BaseModel):
    doc_id: str
    doc_name: str
    format: str
    offset: int
    line: int
    preview: str


class McpGrepOut(BaseModel):
    hits: list[McpGrepHit]
    truncated: bool


class McpOutlineSection(BaseModel):
    level: int
    title: str
    offset: int


class McpOutlineOut(BaseModel):
    doc_id: str
    name: str
    format: str
    sections: list[McpOutlineSection]

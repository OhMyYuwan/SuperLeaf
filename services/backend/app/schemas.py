"""Pydantic schemas for the HTTP API."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    kind: str = Field(pattern="^(dify-local|dify-cloud|claude-direct|claude-local|nanobot|native|codex-local)$")
    endpoint: str = Field(min_length=1, max_length=512)
    api_key: str = Field(min_length=1, max_length=1024)
    activate: bool = False
    transport: str | None = Field(default=None, pattern="^(backend|browser)$")
    workspace_path: str | None = Field(default=None, max_length=2048)
    codex_model: str | None = Field(default=None, max_length=128)
    codex_effort: str | None = Field(default=None, pattern="^(none|minimal|low|medium|high|xhigh)$")
    codex_summary: str | None = Field(default=None, pattern="^(none|auto|concise|detailed)$")
    codex_service_tier: str | None = Field(default=None, max_length=64)
    codex_sandbox: str | None = Field(default=None, pattern="^(read-only|workspace-write|danger-full-access)$")
    codex_approval_policy: str | None = Field(default=None, pattern="^(never|untrusted|on-request|on-failure)$")
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
    codex_sandbox: str | None = Field(default=None, pattern="^(read-only|workspace-write|danger-full-access)$")
    codex_approval_policy: str | None = Field(default=None, pattern="^(never|untrusted|on-request|on-failure)$")
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


class WorkflowDefinitionIn(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    description: str = ""
    execution_mode: str = Field(pattern="^(parallel|pipeline|roundtable|graph)$")
    graph: dict = Field(default_factory=dict)
    config: dict = Field(default_factory=dict)


class WorkflowDefinitionOut(BaseModel):
    id: str
    project_id: str
    name: str
    description: str
    execution_mode: str
    graph: dict
    config: dict
    version: int
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


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


class SkillIn(BaseModel):
    name: str = Field(default="", max_length=128)
    folder_name: str = Field(default="", max_length=128)
    entry_filename: str = Field(default="SKILL.md", max_length=64)
    description: str = ""
    content: str = Field(min_length=1, max_length=60000)
    tags: list[str] = Field(default_factory=list)


class SkillRecipeIn(BaseModel):
    name: str = Field(default="", max_length=128)
    description: str = ""
    repo_url: str = Field(default="", max_length=1024)
    source_url: str = Field(default="", max_length=1200)
    source_ref: str = Field(default="", max_length=128)
    skill_name: str = Field(default="", max_length=256)
    install_command: str = Field(default="", max_length=2048)
    tags: list[str] = Field(default_factory=list)


class SkillPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    content: str | None = Field(default=None, max_length=60000)
    tags: list[str] | None = None


class SkillOut(BaseModel):
    id: str
    owner_user_id: str
    name: str
    public_name: str
    description: str
    content: str
    visibility: str
    source: str
    project_id: str = ""
    cache_version: int = 0
    cache_updated_at: datetime | None = None
    version: int
    tags: list[str]
    created_at: datetime
    updated_at: datetime
    published_at: datetime | None
    can_edit: bool = False
    used_by_agent_count: int = 0

    class Config:
        from_attributes = True


class SkillUsageOut(BaseModel):
    """Per-agent reference to a skill, used by the delete-confirmation UI to
    name which Agents will lose this skill."""
    agent_id: str
    agent_name: str
    project_id: str


class SkillMarketplaceEntryOut(BaseModel):
    id: str
    name: str
    display_name: str
    version: str
    author_github: str
    description: str
    tags: list[str]
    license: str
    path: str
    entry: str
    skill_url: str
    entry_url: str
    readme_url: str = ""
    checksum_sha256: str
    repo_url: str = ""
    source_url: str = ""
    source_ref: str = ""
    skill_name: str = ""
    install_command: str = ""
    installed: bool = False
    installed_skill_id: str | None = None
    installed_version: str = ""
    update_available: bool = False


class SkillMarketplaceOut(BaseModel):
    catalog_url: str
    skills: list[SkillMarketplaceEntryOut]


class SkillMarketplaceInstallOut(BaseModel):
    skill: SkillOut
    marketplace_entry: SkillMarketplaceEntryOut


class SkillMarketplaceCloneOut(BaseModel):
    """Response for clone-to-local: returns the new editable local skill."""
    skill: SkillOut


class SkillMarketplaceCloneIn(BaseModel):
    """Request body for clone-to-local: user-provided name for the local copy."""
    name: str = Field(default="", max_length=128)


class NativeAgentSkillRecipeIn(BaseModel):
    source: str = Field(default="marketplace", max_length=32)
    marketplace_id: str = Field(default="", max_length=256)
    repo_url: str = Field(default="", max_length=1024)
    source_url: str = Field(default="", max_length=1200)
    source_ref: str = Field(default="", max_length=128)
    skill_name: str = Field(default="", max_length=256)
    install_command: str = Field(default="", max_length=2048)


class NativeAgentSkillInstallOut(BaseModel):
    id: str
    project_id: str
    user_id: str
    agent_id: str
    skill_id: str = ""
    source: str
    marketplace_id: str
    repo_url: str
    source_ref: str
    skill_name: str
    folder_name: str
    install_command: str
    folder_path: str
    manifest: dict
    status: str
    install_log: str
    created_at: datetime
    updated_at: datetime
    installed_at: datetime | None

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


class WorkflowTestCaseIn(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    prompt: str = ""
    inputs: dict = Field(default_factory=dict)


class WorkflowTestCaseOut(BaseModel):
    id: str
    definition_id: str
    name: str
    prompt: str
    inputs: dict
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WorkflowRunOut(BaseModel):
    id: str
    project_id: str
    provider_id: str
    workflow_id: str
    workflow_definition_id: str | None
    document_id: str
    range_start: int
    range_end: int
    source_text: str = ""
    status: str
    external_run_id: str
    outputs: dict
    trace: list
    current_round: int
    max_rounds: int
    error: str
    started_at: datetime
    finished_at: datetime | None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Local filesystem schemas (A1)
# ---------------------------------------------------------------------------


class ProjectOut(BaseModel):
    id: str
    user_id: str
    name: str
    main_doc_id: str
    compiler: str
    project_type: str = "paper"
    is_skill_project: bool = False
    project_skill_id: str = ""
    skill_cache_version: int = 0
    skill_cache_updated_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    my_role: str = "owner"

    class Config:
        from_attributes = True


class ProjectCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    project_type: str = Field(default="paper", pattern="^(paper|skill|data)$")


class GitHubProjectImportIn(BaseModel):
    repo_url: str = Field(min_length=1, max_length=512)
    branch: str | None = Field(default=None, max_length=128)
    name: str | None = Field(default=None, max_length=128)


class ProjectUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    main_doc_id: str | None = None
    compiler: str | None = None
    is_skill_project: bool | None = None
    project_type: str | None = Field(default=None, pattern="^(paper|skill|data)$")


class DatasetProjectOut(BaseModel):
    id: str
    project_id: str
    user_id: str
    name: str
    guidelines: str
    label_schema: dict
    status: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class DatasetProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    guidelines: str | None = None
    label_schema: dict | None = None


class DatasetFilterOptionOut(BaseModel):
    id: str
    name: str
    kind: str = ""
    filter_key: str = ""
    project_id: str = ""
    description: str = ""
    disabled: bool = False


class DatasetFilterOptionsOut(BaseModel):
    agents: list[DatasetFilterOptionOut]
    skills: list[DatasetFilterOptionOut]
    workflows: list[DatasetFilterOptionOut]


class DatasetSourceRuleIn(BaseModel):
    source_project_id: str = Field(min_length=1, max_length=64)
    name: str = Field(default="", max_length=128)
    source_types: list[str] = Field(default_factory=lambda: ["annotations", "conversations", "workflow_runs"])
    filters: dict = Field(default_factory=dict)
    is_enabled: bool = True


class DatasetSourceRulePatch(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    source_types: list[str] | None = None
    filters: dict | None = None
    is_enabled: bool | None = None


class DatasetSourceRuleOut(BaseModel):
    id: str
    dataset_project_id: str
    source_project_id: str
    user_id: str
    name: str
    source_types: list
    filters: dict
    last_cursor: dict
    rule_version: int
    is_enabled: bool
    last_synced_at: datetime | None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class DatasetBatchOut(BaseModel):
    id: str
    dataset_project_id: str
    source_rule_id: str
    user_id: str
    cursor_from: dict
    cursor_to: dict
    counts: dict
    created_at: datetime

    class Config:
        from_attributes = True


class DatasetResponseIn(BaseModel):
    status: str = Field(default="draft", pattern="^(draft|submitted|discarded)$")
    values: dict = Field(default_factory=dict)
    lead_time_ms: int = Field(default=0, ge=0)


class DatasetResponseOut(BaseModel):
    id: str
    dataset_project_id: str
    record_id: str
    user_id: str
    status: str
    values: dict
    lead_time_ms: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class DatasetRecordOut(BaseModel):
    id: str
    dataset_project_id: str
    batch_id: str
    source_rule_id: str
    user_id: str
    source_type: str
    source_id: str
    source_created_at: datetime | None
    fingerprint: str
    fields: dict
    record_metadata: dict
    provenance: dict
    status: str
    split: str
    created_at: datetime
    updated_at: datetime
    my_response: DatasetResponseOut | None = None

    class Config:
        from_attributes = True


class DatasetSyncOut(BaseModel):
    batch: DatasetBatchOut
    created: int
    skipped: int
    scanned: int


class DatasetRecordListOut(BaseModel):
    records: list[DatasetRecordOut]
    total: int


class ProjectSkillCacheOut(BaseModel):
    project: ProjectOut
    skill: SkillOut


class ProjectSkillDataPackageIn(BaseModel):
    data_project_id: str = Field(min_length=1, max_length=64)
    status: str = Field(
        default="submitted",
        pattern="^(submitted|all|pending|in_review|labeled|discarded)$",
    )


class ProjectSkillDataPackageFileOut(BaseModel):
    path: str
    kind: str
    size_bytes: int


class ProjectSkillDataPackageOut(BaseModel):
    dataset_project_id: str
    dataset_name: str
    status_filter: str
    record_count: int
    folder: str
    files: list[ProjectSkillDataPackageFileOut]
    generated_at: str


class ProjectSkillDataClearOut(BaseModel):
    folder: str
    deleted_count: int


class ProjectMemberAddIn(BaseModel):
    email: str = Field(min_length=1, max_length=255)
    role: str = Field(default="editor", pattern="^(editor|viewer)$")


class ProjectMemberOut(BaseModel):
    id: str
    project_id: str
    user_id: str
    user_email: str
    user_display_name: str
    role: str
    status: str
    created_at: datetime

    class Config:
        from_attributes = True


class RecentCollaboratorOut(BaseModel):
    id: str
    user_id: str
    email: str
    display_name: str
    last_collaborated_at: datetime


class ProjectArchiveBindingIn(BaseModel):
    github_repo_url: str = Field(default="", max_length=512)
    github_owner: str = Field(default="", max_length=128)
    github_repo: str = Field(default="", max_length=128)
    github_branch: str = Field(default="yuwanlab-archive", min_length=1, max_length=128)
    github_path: str = Field(default="", max_length=512)
    github_private_required: bool = False


class ProjectArchiveBindingOut(BaseModel):
    project_id: str
    local_repo_path: str
    github_account_id: str = ""
    github_repo_url: str = ""
    github_owner: str
    github_repo: str
    github_branch: str
    github_path: str
    github_private_required: bool
    github_bound_at: datetime | None
    last_local_commit_sha: str
    last_pushed_commit_sha: str

    class Config:
        from_attributes = True


class ProjectArchiveSnapshotIn(BaseModel):
    message: str | None = Field(default=None, max_length=512)


class ProjectArchiveSnapshotOut(BaseModel):
    id: str
    project_id: str
    commit_sha: str
    message: str
    doc_count: int
    file_count: int
    byte_count: int
    pushed_to_github: bool
    created_at: datetime

    class Config:
        from_attributes = True


class ProjectArchiveStatusOut(BaseModel):
    binding: ProjectArchiveBindingOut
    snapshots: list[ProjectArchiveSnapshotOut] = Field(default_factory=list)
    local_dirty: bool = False
    remote_configured: bool = False


class CommitMetaOut(BaseModel):
    sha: str
    short_sha: str
    message: str
    author_name: str
    author_email: str
    date: str
    insertions: int
    deletions: int
    files_changed: int


class FileEntryOut(BaseModel):
    path: str
    blob_sha: str
    size: int


class FileDiffOut(BaseModel):
    path: str
    status: str
    insertions: int
    deletions: int
    patch: str | None


class CommitDiffOut(BaseModel):
    from_sha: str
    to_sha: str
    files: list[FileDiffOut]
    total_insertions: int
    total_deletions: int
    files_changed: int


class MajorVersionCreateIn(BaseModel):
    message: str = Field(min_length=1, max_length=2048)


class MajorVersionRestoreIn(BaseModel):
    message: str | None = Field(default=None, max_length=512)


class GitHubAccountOut(BaseModel):
    connected: bool
    login: str = ""
    name: str = ""
    avatar_url: str = ""
    scope: str = ""
    updated_at: datetime | None = None


class GitHubTokenConnectIn(BaseModel):
    token: str = Field(min_length=1, max_length=4096)


class GitHubOAuthStartOut(BaseModel):
    authorize_url: str


class GitHubDeviceStartIn(BaseModel):
    client_id: str | None = Field(default=None, max_length=128)
    scope: str = Field(default="repo", max_length=512)


class GitHubDeviceStartOut(BaseModel):
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str = ""
    expires_in: int
    interval: int


class GitHubDevicePollIn(BaseModel):
    client_id: str | None = Field(default=None, max_length=128)
    device_code: str = Field(min_length=1, max_length=512)


class GitHubDevicePollOut(BaseModel):
    status: str
    error: str = ""
    interval: int | None = None
    account: GitHubAccountOut | None = None


class GitHubImportIn(BaseModel):
    repo_url: str = Field(min_length=1, max_length=512)
    branch: str | None = Field(default=None, max_length=128)


class GitHubImportOut(BaseModel):
    project_id: str
    repo_url: str
    branch: str
    doc_count: int
    file_count: int
    byte_count: int


class GitHubPushIn(BaseModel):
    message: str | None = Field(default=None, max_length=512)


class GitHubPushOut(BaseModel):
    project_id: str
    repo_url: str
    branch: str
    commit_sha: str
    pushed: bool


class FolderCreateIn(BaseModel):
    parent_folder_id: str | None = None
    name: str = Field(min_length=1, max_length=256)


class FolderOut(BaseModel):
    id: str
    project_id: str
    parent_folder_id: str | None
    name: str
    sort_index: int
    updated_at: datetime

    class Config:
        from_attributes = True


class DocCreateIn(BaseModel):
    folder_id: str | None = None
    name: str = Field(min_length=1, max_length=256)
    format: str = Field(pattern="^(tex|md|txt)$")
    content: str = ""


class DocUpdateIn(BaseModel):
    content: str
    base_version: int | None = Field(default=None, ge=1)
    # Optional origin tag for the V3 history snapshot. Defaults to auto_save.
    origin: str | None = Field(
        default=None,
        pattern="^(auto_save|accept_suggestion|manual|restore|ai_edit)$",
    )


class DocOut(BaseModel):
    id: str
    project_id: str
    folder_id: str | None
    name: str
    format: str
    content: str
    version: int
    updated_at: datetime

    class Config:
        from_attributes = True


class TreeDocOut(BaseModel):
    id: str
    name: str
    format: str
    size_bytes: int
    updated_at: datetime


class TreeFileOut(BaseModel):
    id: str
    name: str
    mime_type: str
    size_bytes: int
    updated_at: datetime


class TreeFolderOut(BaseModel):
    id: str
    name: str
    folders: list[TreeFolderOut] = Field(default_factory=list)
    docs: list[TreeDocOut] = Field(default_factory=list)
    files: list[TreeFileOut] = Field(default_factory=list)


class ProjectTreeOut(BaseModel):
    project_id: str
    project_name: str
    root: TreeFolderOut


TreeFolderOut.model_rebuild()


# ---------------------------------------------------------------------------
# LaTeX compile
# ---------------------------------------------------------------------------


class CompilerInfoOut(BaseModel):
    available: list[str]
    default: str


class CompileIn(BaseModel):
    compiler: str | None = None
    main_doc_id: str | None = None


class CompileOut(BaseModel):
    ok: bool
    compiler: str
    duration_ms: int
    error: str
    # Truncated log preview. Full log is fetched via /api/compile/log.
    log_tail: str
    # Length of the PDF blob in bytes (0 if no PDF).
    pdf_bytes: int


class CompileSyncToPdfIn(BaseModel):
    document_id: str
    offset: int


class CompileSyncToPdfOut(BaseModel):
    page: int
    x: float
    y: float
    width: float | None = None
    height: float | None = None
    line: int
    column: int


class ProjectCompileSettingsIn(BaseModel):
    main_doc_id: str | None = None
    compiler: str | None = None


class ProjectCompileSettingsOut(BaseModel):
    main_doc_id: str
    compiler: str


# ---------------------------------------------------------------------------
# Discussions / chat (W7)
# ---------------------------------------------------------------------------


class ConversationOut(BaseModel):
    id: str
    project_id: str
    document_id: str
    workflow_id: str
    title: str
    user_renamed: bool = False
    is_pinned: bool = False
    sort_index: float | None = None
    external_conversation_id: str
    created_at: datetime
    updated_at: datetime
    # Convenience: number of messages, last message preview.
    message_count: int = 0
    last_message_preview: str = ""

    class Config:
        from_attributes = True


class ConversationCreateIn(BaseModel):
    document_id: str = Field(min_length=1)
    workflow_id: str = Field(min_length=1)
    title: str = ""


class ConversationUpdateIn(BaseModel):
    title: str | None = None
    is_pinned: bool | None = None
    sort_index: float | None = None
    # Explicitly clear sort_index (since None means "no change"). Set to True to
    # release a manually-pinned position back to updated_at-based ordering.
    clear_sort_index: bool = False


class MessageOut(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    range_start: int | None
    range_end: int | None
    external_message_id: str
    error: str
    created_at: datetime

    class Config:
        from_attributes = True


class MessageSendIn(BaseModel):
    content: str = Field(min_length=1)
    range_start: int | None = None
    range_end: int | None = None
    # When provided, anchored selection text + neighbouring context to send to
    # Dify's `inputs` map. Otherwise we send only the message text.
    inputs: dict = Field(default_factory=dict)


class BrowserNanobotPrepareOut(BaseModel):
    run_id: str
    provider_id: str
    endpoint: str
    bridge_endpoint: str = ""
    model: str
    messages: list[dict]
    tools: list[dict]
    user_message: MessageOut
    document_id: str
    range_start: int
    range_end: int
    inputs: dict = Field(default_factory=dict)


class BrowserNanobotToolIn(BaseModel):
    run_id: str
    document_id: str
    range_start: int = 0
    range_end: int = 0
    inputs: dict = Field(default_factory=dict)
    tool_call: dict


class BrowserNanobotToolOut(BaseModel):
    role: str = "tool"
    tool_call_id: str
    content: str
    failed: bool = False
    name: str = ""
    tool_kind: str = ""
    events: list[dict] = Field(default_factory=list)
    model_visible: dict = Field(default_factory=dict)
    ui_meta: dict = Field(default_factory=dict)
    audit: dict = Field(default_factory=dict)


class BrowserNanobotFinishIn(BaseModel):
    run_id: str
    content: str = ""
    error: str = ""


class BrowserCodexPrepareOut(BaseModel):
    run_id: str
    provider_id: str
    endpoint: str
    model: str = "codex"
    system_prompt: str = ""
    prompt: str
    tools: list[dict] = Field(default_factory=list)
    user_message: MessageOut
    document_id: str
    range_start: int
    range_end: int
    workspace_path: str = ""
    prompt_mode: str = "fast-edit"
    codex_settings: dict = Field(default_factory=dict)
    superleaf_context: dict = Field(default_factory=dict)
    inputs: dict = Field(default_factory=dict)


class BrowserCodexToolIn(BaseModel):
    run_id: str
    document_id: str
    range_start: int = 0
    range_end: int = 0
    inputs: dict = Field(default_factory=dict)
    tool_call: dict


class BrowserCodexToolOut(BaseModel):
    role: str = "tool"
    tool_call_id: str
    content: str
    failed: bool = False
    name: str = ""
    tool_kind: str = ""
    events: list[dict] = Field(default_factory=list)
    model_visible: dict = Field(default_factory=dict)
    ui_meta: dict = Field(default_factory=dict)
    audit: dict = Field(default_factory=dict)


class BrowserCodexFinishIn(BaseModel):
    run_id: str
    content: str = ""
    error: str = ""
    codex_session_id: str = ""


class BrowserClaudePrepareOut(BaseModel):
    run_id: str
    provider_id: str
    endpoint: str
    model: str = "claude"
    system_prompt: str = ""
    prompt: str
    tools: list[dict] = Field(default_factory=list)
    user_message: MessageOut
    document_id: str
    range_start: int
    range_end: int
    workspace_path: str = ""
    prompt_mode: str = "fast-edit"
    claude_settings: dict = Field(default_factory=dict)
    superleaf_context: dict = Field(default_factory=dict)
    inputs: dict = Field(default_factory=dict)


class BrowserClaudeToolIn(BaseModel):
    run_id: str
    document_id: str
    range_start: int = 0
    range_end: int = 0
    inputs: dict = Field(default_factory=dict)
    tool_call: dict


class BrowserClaudeToolOut(BaseModel):
    role: str = "tool"
    tool_call_id: str
    content: str
    failed: bool = False
    name: str = ""
    tool_kind: str = ""
    events: list[dict] = Field(default_factory=list)
    model_visible: dict = Field(default_factory=dict)
    ui_meta: dict = Field(default_factory=dict)
    audit: dict = Field(default_factory=dict)


class BrowserClaudeFinishIn(BaseModel):
    run_id: str
    content: str = ""
    error: str = ""
    claude_session_id: str = ""


class MessageInjectIn(BaseModel):
    """Persist a pre-composed message without running an agent.

    Used for @workflow dispatches from the discussion surface: the workflow
    executes out-of-band via /api/workflows/definitions/{id}/execute, and the
    synthesized summary is stored on the conversation so the chat history
    stays coherent.
    """

    role: str = Field(pattern="^(agent|user|system)$")
    content: str = Field(min_length=1)
    range_start: int | None = None
    range_end: int | None = None
    error: str | None = None


# ---------------------------------------------------------------------------
# User / auth (W-users)
# ---------------------------------------------------------------------------


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str
    is_admin: bool
    is_disabled: bool
    created_at: datetime
    last_login_at: datetime | None

    class Config:
        from_attributes = True


class UserRegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(default="", max_length=128)
    bootstrap_token: str = Field(default="", max_length=512)


class UserLoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=128)


class UserUpdateIn(BaseModel):
    is_disabled: bool | None = None
    is_admin: bool | None = None
    display_name: str | None = Field(default=None, max_length=128)


# ---------------------------------------------------------------------------
# History & versioning (V3 Phase 3)
# ---------------------------------------------------------------------------


class LabelOut(BaseModel):
    id: str
    version: int
    text: str
    created_at: datetime

    class Config:
        from_attributes = True


class LabelIn(BaseModel):
    version: int = Field(ge=1)
    text: str = Field(min_length=1, max_length=256)


class VersionOut(BaseModel):
    """List/detail view of a snapshot. `content` is only populated by the
    single-version GET endpoint to keep the listing payload light.
    """

    id: str
    version: int
    blob_hash: str
    created_at: datetime
    origin: str
    actor: str | None
    byte_length: int
    string_length: int | None
    labels: list[LabelOut] = Field(default_factory=list)
    content: str | None = None
    binary: bool = False


class DiffOut(BaseModel):
    """Overleaf-shaped diff payload. `diff` is either a list of parts or
    `{"binary": true}` when at least one side is non-text.
    """

    diff: list[dict] | dict


# ---------------------------------------------------------------------------
# Operation audit log (V3 Phase 3 task 3.3)
# ---------------------------------------------------------------------------


class OperationOut(BaseModel):
    id: str
    doc_id: str
    type: str
    payload: dict
    actor: str | None
    created_at: datetime

    class Config:
        from_attributes = True


class OperationIn(BaseModel):
    type: str = Field(
        pattern="^(accept_suggestion|reject_suggestion|restore|label_add|label_remove)$"
    )
    payload: dict = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Agent usage statistics (V3 Phase 3 task 3.4)
# ---------------------------------------------------------------------------


class AgentStatOut(BaseModel):
    workflow_id: str
    workflow_name: str
    runs: int
    accepts: int
    rejects: int
    accept_rate: float | None
    avg_latency_ms: float | None


class ProviderStatsOut(BaseModel):
    provider_id: str
    agents: list[AgentStatOut]


# ---------------------------------------------------------------------------
# V3 Phase 4 — Annotation evaluation + review status (REQ-0034)
# ---------------------------------------------------------------------------


class EvaluationIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    doc_id: str = Field(min_length=1, max_length=64)
    target_type: str = Field(pattern="^(agent_output|workflow_run|annotation|suggestion)$")
    target_id: str = Field(default="", max_length=128)
    verdict: str = Field(pattern="^(positive|negative)$")
    reason: str = Field(min_length=1, max_length=2048)
    tags: list[str] = Field(default_factory=list)
    adoption: str = Field(
        default="unknown",
        pattern="^(unknown|used|partially_used|not_used|later)$",
    )
    training_candidate: bool = False
    context: dict = Field(default_factory=dict)


class EvaluationPatchIn(BaseModel):
    verdict: str | None = Field(default=None, pattern="^(positive|negative)$")
    reason: str | None = Field(default=None, max_length=2048)
    tags: list[str] | None = None
    adoption: str | None = Field(
        default=None, pattern="^(unknown|used|partially_used|not_used|later)$"
    )
    training_candidate: bool | None = None
    context: dict | None = None


class EvaluationOut(BaseModel):
    id: str
    annotation_id: str
    doc_id: str
    target_type: str
    target_id: str
    verdict: str
    reason: str
    tags: list[str]
    adoption: str
    training_candidate: bool
    context: dict
    created_at: datetime
    updated_at: datetime


class ReviewStatusIn(BaseModel):
    doc_id: str = Field(min_length=1, max_length=64)
    status: str = Field(pattern="^(open|considered|addressed|dismissed)$")


class ReviewStateOut(BaseModel):
    annotation_id: str
    doc_id: str
    status: str
    updated_at: datetime


# --- Annotations (V3 phase 2.5: persisted server-side) ---------------------

class AnnotationThreadMessageIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    role: str = Field(pattern="^(user|agent)$")
    content: str = Field(default="", max_length=20000)
    created_at: datetime
    agent_id: str | None = None
    agent_name: str | None = None


class AnnotationIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    doc_id: str = Field(min_length=1, max_length=64)
    kind: str = Field(pattern="^(annotation|suggestion|risk|user-comment)$")
    status: str = Field(default="pending")
    range_from: int = Field(ge=0)
    range_to: int = Field(ge=0)
    target_text: str = ""
    content: str = ""
    severity: str = Field(default="medium", pattern="^(low|medium|high)$")
    workflow_id: str = ""
    agent_name: str = ""
    conversation_id: str = ""
    original: str = ""
    proposed: str = ""
    reason: str = ""
    risk_type: str = ""
    mitigation: str = ""
    thread: list[AnnotationThreadMessageIn] = []
    # Opaque JSON list — the resolver attaches arbitrary metadata
    # (path/kind/mime/truncated/omitted/content). Stored as-is so we don't
    # have to evolve a column for every resolver field.
    attached_files: list[dict] = []
    created_at: datetime


class AnnotationPatchIn(BaseModel):
    status: str | None = None
    range_from: int | None = Field(default=None, ge=0)
    range_to: int | None = Field(default=None, ge=0)
    content: str | None = None
    thread: list[AnnotationThreadMessageIn] | None = None
    publish: bool | None = None
    archived_at: datetime | None = None


class AnnotationOut(BaseModel):
    id: str
    doc_id: str
    project_id: str
    user_id: str
    is_global: bool
    kind: str
    status: str
    range_from: int
    range_to: int
    target_text: str
    content: str
    severity: str
    workflow_id: str
    agent_name: str
    conversation_id: str
    original: str
    proposed: str
    reason: str
    risk_type: str
    mitigation: str
    thread: list
    attached_files: list
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None = None


class AnnotationAgentSuggestionRunIn(BaseModel):
    doc_id: str = Field(min_length=1, max_length=64)
    agent_id: str = Field(min_length=1, max_length=128)
    include_stale: bool = True
    scope: str = Field(default="current_doc", pattern="^current_doc$")


class AnnotationAgentSuggestionPatchIn(BaseModel):
    status: str | None = Field(
        default=None, pattern="^(drafted|stale|ready|published|failed)$"
    )
    suggestions: list[str] | None = None


class AnnotationAgentSuggestionOut(BaseModel):
    id: str
    project_id: str
    doc_id: str
    annotation_id: str
    user_id: str
    agent_id: str
    source_hash: str
    status: str
    suggestions: list
    internal_meta: dict
    error: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AnnotationAgentSuggestionRunOut(BaseModel):
    processed: int
    skipped: int
    failed: int
    suggestions: list[AnnotationAgentSuggestionOut]


# ---------------------------------------------------------------------------
# Notifications (multi-user collaboration)
# ---------------------------------------------------------------------------


class NotificationOut(BaseModel):
    id: str
    user_id: str
    kind: str
    title: str
    body: str
    target_id: str
    target_type: str
    is_read: bool
    created_at: datetime

    class Config:
        from_attributes = True

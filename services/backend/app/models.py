"""SQLAlchemy models.

W2a 最小集：Provider（Dify/Claude 凭据配置）、CachedWorkflow（Dify workflow 列表缓存）。
后续 W2b+ 会加入 Document/Annotation/Suggestion/Risk/Operation/Discussion/Message。
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _uuid() -> str:
    return uuid4().hex


# ---------------------------------------------------------------------------
# Users + sessions
# ---------------------------------------------------------------------------


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(128), default="")
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_login_ip: Mapped[str] = mapped_column(String(64), default="")


class Session(Base):
    """Opaque server-side session row. `id` is the cookie value itself."""

    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    ip: Mapped[str] = mapped_column(String(64), default="")


class GitHubAccount(Base):
    """User-scoped GitHub authorization.

    Tokens are encrypted with the same local Fernet vault as provider API keys.
    The app stores one connected GitHub account per user for now; repository
    selection stays per project archive binding.
    """

    __tablename__ = "github_accounts"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_github_accounts_user"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    github_user_id: Mapped[str] = mapped_column(String(64), default="")
    login: Mapped[str] = mapped_column(String(128), default="")
    name: Mapped[str] = mapped_column(String(256), default="")
    avatar_url: Mapped[str] = mapped_column(String(512), default="")
    token_type: Mapped[str] = mapped_column(String(32), default="bearer")
    scope: Mapped[str] = mapped_column(String(512), default="")
    access_token_enc: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class GitHubOAuthState(Base):
    """Short-lived OAuth CSRF state row."""

    __tablename__ = "github_oauth_states"

    state: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class SpellingPreference(Base):
    """User-private spelling preferences for editor spell checking."""

    __tablename__ = "spelling_preferences"
    __table_args__ = (
        UniqueConstraint("user_id", "language", name="uq_spelling_preferences_user_language"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    language: Mapped[str] = mapped_column(String(32), default="en")
    words: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


# ---------------------------------------------------------------------------
# Providers + cached workflows (per-user)
# ---------------------------------------------------------------------------


class Provider(Base):
    __tablename__ = "providers"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    name: Mapped[str] = mapped_column(String(128))
    # 'dify-local' | 'dify-cloud' | 'claude-direct' | 'nanobot'
    kind: Mapped[str] = mapped_column(String(32))
    # API base URL; for dify-cloud typically https://api.dify.ai/v1
    endpoint: Mapped[str] = mapped_column(String(512))
    # Encrypted API key (Fernet). Never stored in plain text.
    api_key_enc: Mapped[str] = mapped_column(Text, default="")
    # Last known status: 'unknown' | 'ok' | 'error'
    status: Mapped[str] = mapped_column(String(16), default="unknown")
    status_detail: Mapped[str] = mapped_column(Text, default="")
    # Only one provider can be active at a time per user (enforced in service layer).
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class CachedWorkflow(Base):
    """Mirror of Dify workflows the user has installed.

    We cache so the UI can render the team-management panel even when Dify is
    unreachable, and so we can pin an external workflow ID to our local stats.
    """

    __tablename__ = "cached_workflows"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    provider_id: Mapped[str] = mapped_column(ForeignKey("providers.id", ondelete="CASCADE"))
    # Dify-side identifier
    external_id: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str] = mapped_column(Text, default="")
    # 'workflow' | 'chatflow' | 'agent'
    kind: Mapped[str] = mapped_column(String(32), default="workflow")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)
    # Agent can be disabled (hidden from @mention, cannot be used for follow-up)
    is_disabled: Mapped[bool] = mapped_column(Boolean, default=False)


class WorkflowDefinition(Base):
    """User-defined workflow graph for orchestrating multiple agents.

    Stores the node/edge structure for parallel, pipeline, roundtable, and graph execution modes.
    Each workflow can be executed multiple times, creating WorkflowRun instances.

    Execution modes:
    - parallel: All agent nodes execute simultaneously
    - pipeline: Sequential execution following topological order
    - roundtable: Circular discussion with convergence detection
    - graph: General-purpose DAG with support for nested workflows, branching, and merging
    """

    __tablename__ = "workflow_definitions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, default="")
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str] = mapped_column(Text, default="")
    # 'parallel' | 'pipeline' | 'roundtable' | 'graph'
    execution_mode: Mapped[str] = mapped_column(String(32), default="pipeline")
    # JSON graph: { nodes: [...], edges: [...] }
    graph: Mapped[dict] = mapped_column(JSON, default=dict)
    # Workflow configuration (max_rounds, stop_conditions, etc.)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    # Version number for tracking changes
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class NativeAgentCredential(Base):
    """Encrypted credential for backend-run native Agents.

    Credentials are user-private even when the Agent configuration itself is
    project-scoped. This keeps base URLs/API keys tied to the person who
    configured them while allowing a project Agent to be imported/exported
    later without leaking secrets.
    """

    __tablename__ = "native_agent_credentials"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    name: Mapped[str] = mapped_column(String(128))
    base_url: Mapped[str] = mapped_column(String(512))
    api_key_enc: Mapped[str] = mapped_column(Text, default="")
    runtime_kind: Mapped[str] = mapped_column(String(64), default="openai-agents-sdk")
    default_model: Mapped[str] = mapped_column(String(128), default="")
    status: Mapped[str] = mapped_column(String(16), default="unknown")
    status_detail: Mapped[str] = mapped_column(Text, default="")
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class Skill(Base):
    """Skill registry entry for native Agents.

    Uploaded Skills default to private ownership. Public Skills are named by
    the backend as `username@skill_name` and are readable by all project users.
    """

    __tablename__ = "skills"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    owner_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    name: Mapped[str] = mapped_column(String(128))
    public_name: Mapped[str] = mapped_column(String(256), default="", index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    visibility: Mapped[str] = mapped_column(String(16), default="private")
    source: Mapped[str] = mapped_column(String(16), default="upload")
    version: Mapped[int] = mapped_column(Integer, default=1)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SkillHidden(Base):
    """Per-user removal from the local Skill library without deleting source."""

    __tablename__ = "skill_hidden"
    __table_args__ = (
        UniqueConstraint("user_id", "skill_key", name="uq_skill_hidden_user_key"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    skill_key: Mapped[str] = mapped_column(String(256), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class NativeAgent(Base):
    """Project-scoped backend-run Agent configuration."""

    __tablename__ = "native_agents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, default="")
    owner_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    provider_id: Mapped[str] = mapped_column(ForeignKey("providers.id"), index=True, default="")
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text, default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    instructions: Mapped[str] = mapped_column(Text, default="")
    skill_ids: Mapped[list] = mapped_column(JSON, default=list)
    agent_md: Mapped[str] = mapped_column(Text, default="")
    workspace_path: Mapped[str] = mapped_column(String(1024), default="")
    setup_status: Mapped[str] = mapped_column(String(32), default="ready")
    setup_log: Mapped[str] = mapped_column(Text, default="")
    output_contract: Mapped[str] = mapped_column(String(32), default="annotation")
    runtime_config: Mapped[dict] = mapped_column(JSON, default=dict)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class NativeMcpServer(Base):
    """User-scoped MCP server configuration.

    Catalog presets are loaded from the configured SuperLeaf.MCPs catalog URL.
    This table stores the user's configured instance of a preset or a custom MCP
    server, including encrypted env values. Agents reference rows here instead
    of duplicating command/env details in their runtime_config.
    """

    __tablename__ = "native_mcp_servers"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    preset_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    source: Mapped[str] = mapped_column(String(32), default="custom")
    name: Mapped[str] = mapped_column(String(128), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    transport: Mapped[str] = mapped_column(String(32), default="stdio")
    command: Mapped[str] = mapped_column(String(256), default="")
    args: Mapped[list] = mapped_column(JSON, default=list)
    env_enc: Mapped[str] = mapped_column(Text, default="")
    allowed_tools: Mapped[list] = mapped_column(JSON, default=list)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(16), default="unknown")
    status_detail: Mapped[str] = mapped_column(Text, default="")
    last_probe_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_probe_status: Mapped[str] = mapped_column(String(32), default="")
    last_probe_detail: Mapped[str] = mapped_column(Text, default="")
    last_golden_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_golden_status: Mapped[str] = mapped_column(String(32), default="")
    last_golden_detail: Mapped[str] = mapped_column(Text, default="")
    last_tool_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class NativeAgentSkillInstall(Base):
    """Agent-scoped Skill folder installed through an npx recipe.

    The file contents live on disk under the Agent workspace. This row is only
    the searchable install ledger and manifest.
    """

    __tablename__ = "native_agent_skill_installs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, default="")
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    agent_id: Mapped[str] = mapped_column(ForeignKey("native_agents.id"), index=True)
    skill_id: Mapped[str] = mapped_column(String(32), index=True, default="")
    source: Mapped[str] = mapped_column(String(32), default="marketplace")
    marketplace_id: Mapped[str] = mapped_column(String(256), default="")
    repo_url: Mapped[str] = mapped_column(String(1024), default="")
    source_ref: Mapped[str] = mapped_column(String(128), default="")
    skill_name: Mapped[str] = mapped_column(String(256), default="")
    folder_name: Mapped[str] = mapped_column(String(256), default="")
    install_command: Mapped[str] = mapped_column(Text, default="")
    folder_path: Mapped[str] = mapped_column(String(1024), default="")
    manifest: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    install_log: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    installed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class WorkflowTestCase(Base):
    """Reusable test fixture for a WorkflowDefinition.

    Stores the inputs (prompt text + extra JSON inputs) under a name so the
    user can re-run the same scenario against an edited workflow definition
    and eyeball the diff in the editor's test panel.
    """

    __tablename__ = "workflow_test_cases"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    definition_id: Mapped[str] = mapped_column(
        ForeignKey("workflow_definitions.id"), index=True
    )
    name: Mapped[str] = mapped_column(String(256))
    prompt: Mapped[str] = mapped_column(Text, default="")
    inputs: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class WorkflowRun(Base):
    """Persisted record of a single workflow invocation.

    For simple single-agent runs (Dify/Nanobot), we track basic execution info.
    For orchestrated multi-agent runs (WorkflowDefinition), we track node-level trace.
    """

    __tablename__ = "workflow_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, default="")
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    provider_id: Mapped[str] = mapped_column(ForeignKey("providers.id"))
    # For single-agent runs: references CachedWorkflow
    workflow_id: Mapped[str] = mapped_column(ForeignKey("cached_workflows.id"))
    # For orchestrated runs: references WorkflowDefinition
    workflow_definition_id: Mapped[str | None] = mapped_column(
        ForeignKey("workflow_definitions.id"), nullable=True
    )
    document_id: Mapped[str] = mapped_column(String(64))
    range_start: Mapped[int] = mapped_column(Integer)
    range_end: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="running")
    # Dify run id (returned by workflow API) — useful for cross-referencing in Dify logs.
    external_run_id: Mapped[str] = mapped_column(String(128), default="")
    outputs: Mapped[dict] = mapped_column(JSON, default=dict)
    # Node-level execution trace for orchestrated workflows
    # Format: [{ nodeId, agentId, startTime, endTime, status, input, output, error }, ...]
    trace: Mapped[list] = mapped_column(JSON, default=list)
    # Current round number (for roundtable mode)
    current_round: Mapped[int] = mapped_column(Integer, default=0)
    # Maximum rounds allowed (for roundtable mode)
    max_rounds: Mapped[int] = mapped_column(Integer, default=3)
    error: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


# ---------------------------------------------------------------------------
# Local project filesystem (A1)
# ---------------------------------------------------------------------------


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    name: Mapped[str] = mapped_column(String(128), default="Untitled Project")
    # LaTeX compile settings
    main_doc_id: Mapped[str] = mapped_column(String(32), default="")
    compiler: Mapped[str] = mapped_column(String(32), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class ProjectMember(Base):
    """Multi-user project collaboration (Overleaf-style).

    Allows multiple users to access the same project. The project owner
    (Project.user_id) has full control; members have read-write access.
    Future: add role field for granular permissions (viewer/editor/admin).
    """

    __tablename__ = "project_members"
    __table_args__ = (
        UniqueConstraint("project_id", "user_id", name="uq_project_members_project_user"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    # 'editor' | 'viewer' (future: 'admin')
    role: Mapped[str] = mapped_column(String(16), default="editor")
    # 'pending' | 'accepted' | 'declined' (future: invitation workflow)
    status: Mapped[str] = mapped_column(String(16), default="accepted")
    invited_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class RecentCollaborator(Base):
    """Per-user recent collaborators remembered across projects.

    This acts like an invite contact list: even if a project member is later
    removed, the user still appears as someone the owner has collaborated with.
    Email/display name are snapshotted so the list remains useful if the user
    profile changes or becomes unavailable.
    """

    __tablename__ = "recent_collaborators"
    __table_args__ = (
        UniqueConstraint(
            "owner_user_id",
            "collaborator_user_id",
            name="uq_recent_collaborators_owner_collaborator",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    owner_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    collaborator_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    collaborator_email: Mapped[str] = mapped_column(String(255), default="")
    collaborator_display_name: Mapped[str] = mapped_column(String(128), default="")
    last_collaborated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class ProjectArchiveBinding(Base):
    """Project-level archive settings.

    Local Git is the first-class archive store. GitHub metadata is deliberately
    a binding target, not a live collaboration source: future push/import flows
    can use it without changing the local snapshot model.
    """

    __tablename__ = "project_archive_bindings"
    __table_args__ = (
        UniqueConstraint("project_id", name="uq_project_archive_bindings_project"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    local_repo_path: Mapped[str] = mapped_column(String(1024), default="")
    github_account_id: Mapped[str] = mapped_column(String(32), default="")
    github_repo_url: Mapped[str] = mapped_column(String(512), default="")
    github_owner: Mapped[str] = mapped_column(String(128), default="")
    github_repo: Mapped[str] = mapped_column(String(128), default="")
    github_branch: Mapped[str] = mapped_column(String(128), default="yuwanlab-archive")
    github_path: Mapped[str] = mapped_column(String(512), default="")
    github_private_required: Mapped[bool] = mapped_column(Boolean, default=True)
    github_bound_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_local_commit_sha: Mapped[str] = mapped_column(String(64), default="")
    last_pushed_commit_sha: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class ProjectArchiveSnapshot(Base):
    """One project-level snapshot commit in the local archive repo."""

    __tablename__ = "project_archive_snapshots"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    commit_sha: Mapped[str] = mapped_column(String(64), index=True)
    message: Mapped[str] = mapped_column(String(512), default="")
    doc_count: Mapped[int] = mapped_column(Integer, default=0)
    file_count: Mapped[int] = mapped_column(Integer, default=0)
    byte_count: Mapped[int] = mapped_column(Integer, default=0)
    pushed_to_github: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Folder(Base):
    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    parent_folder_id: Mapped[str | None] = mapped_column(
        ForeignKey("folders.id"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(256))
    sort_index: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class Doc(Base):
    __tablename__ = "docs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    folder_id: Mapped[str | None] = mapped_column(ForeignKey("folders.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(256))
    format: Mapped[str] = mapped_column(String(16), default="tex")
    content: Mapped[str] = mapped_column(Text, default="")
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class FileBlob(Base):
    __tablename__ = "files"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    folder_id: Mapped[str | None] = mapped_column(ForeignKey("folders.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(256))
    mime_type: Mapped[str] = mapped_column(String(128), default="application/octet-stream")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    blob: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


# ---------------------------------------------------------------------------
# Discussions / chat (W7)
# ---------------------------------------------------------------------------


class Conversation(Base):
    """A chat thread between the user and one Agent (cached_workflow), scoped
    to a document. Mirrors Dify's `conversation_id` so follow-up messages stay
    in the same context window on the Dify side.
    """

    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, default="")
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    document_id: Mapped[str] = mapped_column(String(64), index=True)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("cached_workflows.id"), index=True)
    title: Mapped[str] = mapped_column(String(256), default="")
    # True once the user has explicitly renamed this conversation; suppresses auto-naming.
    user_renamed: Mapped[bool] = mapped_column(Boolean, default=False)
    # Pin to top of the list; pinned items sort above unpinned ones.
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    # Manual sort key. NULL → fall back to updated_at; non-NULL → pinned to that position
    # (won't bubble on new messages). Higher value = higher in list.
    sort_index: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    # Dify's conversation id once we know it (after first message).
    external_conversation_id: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class Message(Base):
    """One turn in a conversation. `role` is 'user' or 'agent'."""

    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, default="")
    # Optional anchor: if the user attached a selection range when sending.
    range_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    range_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Dify message id (for user → agent traceability).
    external_message_id: Mapped[str] = mapped_column(String(128), default="")
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ---------------------------------------------------------------------------
# History & versioning (V3 Phase 3) — Overleaf-inspired three-table storage
# ---------------------------------------------------------------------------


class Blob(Base):
    """Content-addressed blob shared by all document versions.

    SHA1 hex over the raw bytes is the primary key, so identical content
    (e.g. two snapshots taken before/after a no-op cooldown skip) reuses
    the same row across documents.
    """

    __tablename__ = "blobs"

    hash: Mapped[str] = mapped_column(String(40), primary_key=True)
    content: Mapped[bytes] = mapped_column(LargeBinary)
    byte_length: Mapped[int] = mapped_column(Integer, default=0)
    # None ⇒ binary blob (the document is not decodable as UTF-8 text).
    string_length: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DocumentVersion(Base):
    """One historical snapshot of a Doc, pointing at a Blob.

    `version` is monotonically increasing per doc_id and unique within that
    scope. The 20-version cap is enforced at write time by version_service.
    """

    __tablename__ = "document_versions"
    __table_args__ = (
        UniqueConstraint("doc_id", "version", name="uq_document_versions_doc_version"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    doc_id: Mapped[str] = mapped_column(ForeignKey("docs.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    blob_hash: Mapped[str] = mapped_column(ForeignKey("blobs.hash"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # auto_save | accept_suggestion | manual | restore | ai_edit
    origin: Mapped[str] = mapped_column(String(32), default="auto_save")
    # Optional user/agent identifier (free-form; nullable for system writes).
    actor: Mapped[str | None] = mapped_column(String(128), nullable=True)


class DocumentLabel(Base):
    """User-named version pin. Labels protect their version from LRU eviction."""

    __tablename__ = "document_labels"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    doc_id: Mapped[str] = mapped_column(ForeignKey("docs.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Operation(Base):
    """Append-only audit log of user/agent actions on a doc.

    Captures coarse events (accept_suggestion, reject_suggestion, restore,
    label_add, label_remove). Suggestion accept/reject originate in the
    frontend annotation store and are POSTed here for persistence; restore
    and label events are recorded by the version routes directly.
    """

    __tablename__ = "operations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    doc_id: Mapped[str] = mapped_column(ForeignKey("docs.id"), index=True)
    # accept_suggestion | reject_suggestion | restore | label_add | label_remove
    type: Mapped[str] = mapped_column(String(32))
    # Free-form context: { version, label_id, label_text, annotation_id,
    # workflow_id, range_start, range_end, target_text_excerpt, ... }
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    actor: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True
    )


# ---------------------------------------------------------------------------
# V3 Phase 4 — Annotation evaluation + review status
#
# Annotations themselves still live in the frontend zustand store (see
# frontend/src/stores/annotationStore.ts). These two tables attach user
# review + evaluation data by annotation_id *string* only — no foreign key,
# since the author of the annotation string is the browser. Doc-scoped
# indexes let us pull everything for a doc with one query each.
# ---------------------------------------------------------------------------


class AnnotationEvaluation(Base):
    """User-authored ✅/❎ verdict on a specific Agent output.

    Mirrors the AgentEvaluation interface in the frontend store one-for-one.
    `context` carries captured provenance (document_hash, section,
    surrounding_before/after, etc.); server-side enrichment may add
    workflow_run_id / workflow_id pulled from the Operation audit log.
    """

    __tablename__ = "annotation_evaluations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # frontend uuid
    annotation_id: Mapped[str] = mapped_column(String(64), index=True)
    doc_id: Mapped[str] = mapped_column(ForeignKey("docs.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    target_type: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[str] = mapped_column(String(128), default="")
    verdict: Mapped[str] = mapped_column(String(16))  # positive | negative
    reason: Mapped[str] = mapped_column(String(2048))
    tags: Mapped[list] = mapped_column(JSON, default=list)
    adoption: Mapped[str] = mapped_column(String(32), default="unknown")
    training_candidate: Mapped[bool] = mapped_column(Boolean, default=False)
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class AnnotationReviewState(Base):
    """User's handling state for an annotation (open / considered /
    addressed / dismissed).

    Kept separate from the frontend `AnnotationItem.status` (which tracks
    archive/delete) because review state is orthogonal — you can have an
    archived+dismissed or pending+considered combo.
    """

    __tablename__ = "annotation_review_states"

    annotation_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    doc_id: Mapped[str] = mapped_column(ForeignKey("docs.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    status: Mapped[str] = mapped_column(String(16))  # open | considered | addressed | dismissed
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class Annotation(Base):
    """V3 phase 2.5 — annotation card persisted server-side.

    Previously the cards (suggestion / annotation / risk / user-comment) lived
    only in the frontend zustand store, which made cross-device and multi-
    user collaboration impossible. The card is now stored here; only the
    transient editor decoration state stays client-side.

    `thread` is a JSON list of `{id, role, content, created_at, agent_id?,
    agent_name?}`. Threads are append-only in practice; for now we replace
    the whole list on every mutation rather than introducing a child table
    until we need per-message permissions.
    """

    __tablename__ = "annotations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # frontend uuid
    doc_id: Mapped[str] = mapped_column(ForeignKey("docs.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, default="")
    is_global: Mapped[bool] = mapped_column(Boolean, default=False)
    kind: Mapped[str] = mapped_column(String(24))  # annotation | suggestion | risk | user-comment
    status: Mapped[str] = mapped_column(String(24), default="pending")
    range_from: Mapped[int] = mapped_column(Integer, default=0)
    range_to: Mapped[int] = mapped_column(Integer, default=0)
    target_text: Mapped[str] = mapped_column(Text, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    severity: Mapped[str] = mapped_column(String(16), default="medium")
    workflow_id: Mapped[str] = mapped_column(String(128), default="")
    agent_name: Mapped[str] = mapped_column(String(128), default="")
    conversation_id: Mapped[str] = mapped_column(String(64), default="")
    # Suggestion-specific
    original: Mapped[str] = mapped_column(Text, default="")
    proposed: Mapped[str] = mapped_column(Text, default="")
    reason: Mapped[str] = mapped_column(Text, default="")
    # Risk-specific
    risk_type: Mapped[str] = mapped_column(String(32), default="")
    mitigation: Mapped[str] = mapped_column(Text, default="")
    # JSON
    thread: Mapped[list] = mapped_column(JSON, default=list)
    attached_files: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


# ---------------------------------------------------------------------------
# Notifications (multi-user collaboration)
# ---------------------------------------------------------------------------


class Notification(Base):
    """In-app notification for collaboration events (invitations, etc.)."""

    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    # 'project_invite' | 'project_joined' | 'mention' | 'system'
    kind: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(256))
    body: Mapped[str] = mapped_column(Text, default="")
    # Optional link target (e.g. project_id)
    target_id: Mapped[str] = mapped_column(String(64), default="")
    target_type: Mapped[str] = mapped_column(String(32), default="")
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

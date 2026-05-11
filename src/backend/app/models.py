"""SQLAlchemy models.

W2a 最小集：Provider（Dify/Claude 凭据配置）、CachedWorkflow（Dify workflow 列表缓存）。
后续 W2b+ 会加入 Document/Annotation/Suggestion/Risk/Operation/Discussion/Message。
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint
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
    document_id: Mapped[str] = mapped_column(String(64), index=True)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("cached_workflows.id"), index=True)
    title: Mapped[str] = mapped_column(String(256), default="")
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

"""Pydantic schemas for the HTTP API."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    kind: str = Field(pattern="^(dify-local|dify-cloud|claude-direct|nanobot)$")
    endpoint: str = Field(min_length=1, max_length=512)
    api_key: str = Field(min_length=1, max_length=1024)
    activate: bool = False


class ProviderUpdate(BaseModel):
    name: str | None = None
    endpoint: str | None = None
    api_key: str | None = None  # empty/None means "don't rotate"


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
    name: str
    main_doc_id: str
    compiler: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ProjectCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class ProjectUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    main_doc_id: str | None = None
    compiler: str | None = None


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
    folders: list["TreeFolderOut"] = Field(default_factory=list)
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

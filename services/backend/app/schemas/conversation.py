"""讨论/聊天会话、消息与浏览器工具桥接 schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


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

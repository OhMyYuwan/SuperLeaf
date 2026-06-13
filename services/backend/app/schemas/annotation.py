"""批注评价、审阅状态与 Agent 建议 schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


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
    target_kind: str = Field(default="agent", pattern="^(agent|workflow)$")
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

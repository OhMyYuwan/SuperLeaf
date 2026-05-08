"""Pydantic schemas for the HTTP API."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    kind: str = Field(pattern="^(dify-local|dify-cloud|claude-direct)$")
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

    class Config:
        from_attributes = True


class WorkflowRunOut(BaseModel):
    id: str
    provider_id: str
    workflow_id: str
    document_id: str
    range_start: int
    range_end: int
    status: str
    external_run_id: str
    outputs: dict
    error: str
    started_at: datetime
    finished_at: datetime | None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Local filesystem schemas (A1)
# ---------------------------------------------------------------------------


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

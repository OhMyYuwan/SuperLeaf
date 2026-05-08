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

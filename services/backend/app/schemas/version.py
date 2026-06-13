"""历史版本、diff、标签与操作审计 schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


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

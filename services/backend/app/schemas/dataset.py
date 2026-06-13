"""数据集项目、来源规则与标注记录 schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


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

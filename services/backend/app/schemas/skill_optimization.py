"""Pydantic schemas for Skill Optimization API."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# OptimizationRun
# ---------------------------------------------------------------------------


class OptimizationRunCreate(BaseModel):
    skill_id: str
    data_project_id: str
    signal_sources: dict[str, Any] = Field(default_factory=dict)


class OptimizationRunOut(BaseModel):
    id: str
    data_project_id: str
    skill_id: str
    skill_project_id: str
    user_id: str
    status: str
    signal_sources: dict[str, Any]
    signal_snapshot: dict[str, Any]
    diagnosis: dict[str, Any]
    generated_artifacts: list[dict[str, Any]]
    eval_results: dict[str, Any]
    diff_from_previous: str
    review_status: str
    review_notes: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class OptimizationRunListOut(BaseModel):
    items: list[OptimizationRunOut]
    total: int


class OptimizationReviewIn(BaseModel):
    action: str = Field(pattern="^(approve|reject)$")
    notes: str = ""


class DiagnosisOut(BaseModel):
    failure_patterns: list[dict[str, Any]]
    golden_examples: list[dict[str, Any]]
    negative_examples: list[dict[str, Any]]
    workflow_patterns: list[dict[str, Any]]
    sedimentation_candidates: list[dict[str, Any]]
    optimization_suggestions: list[dict[str, Any]]
    summary: dict[str, Any]


class ArtifactOut(BaseModel):
    path: str
    kind: str
    action: str
    size_bytes: int


class GenerationResultOut(BaseModel):
    artifacts: list[ArtifactOut]
    skill_md_diff: str
    error: str


class EvalResultOut(BaseModel):
    summary: dict[str, Any]
    cases: list[dict[str, Any]]
    regressions: list[dict[str, Any]]


# ---------------------------------------------------------------------------
# Handoff
# ---------------------------------------------------------------------------


class HandoffRequest(BaseModel):
    data_project_id: str
    skill_project_id: str
    include_diagnosis: bool = True
    status_filter: str = "submitted"


class HandoffResultOut(BaseModel):
    dataset_project_id: str
    dataset_name: str
    status_filter: str
    record_count: int
    folder: str
    files: list[dict[str, Any]]
    generated_at: str


# ---------------------------------------------------------------------------
# Sedimentation
# ---------------------------------------------------------------------------


class SedimentationCreate(BaseModel):
    conversation_id: str
    project_id: str
    skill_id: str | None = None


class SedimentationOut(BaseModel):
    id: str
    user_id: str
    source_conversation_id: str
    source_project_id: str
    skill_id: str | None
    procedure_summary: str
    status: str
    created_by: str
    created_at: datetime

    class Config:
        from_attributes = True


class SedimentationListOut(BaseModel):
    items: list[SedimentationOut]
    total: int


class SedimentationReviewIn(BaseModel):
    action: str = Field(pattern="^(merge|discard)$")
    target_skill_id: str | None = None

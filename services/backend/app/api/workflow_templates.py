"""/api/workflow-templates — Workflow template listing and preparation."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import User
from ..services.workflow_template_service import WorkflowTemplateService
from .deps import get_current_user

router = APIRouter(prefix="/api/workflow-templates", tags=["workflow-templates"])

CurrentUser = Depends(get_current_user)
DbSession = Depends(get_session)


class TemplatePrepareIn(BaseModel):
    project_id: str


class TemplatePrepareOut(BaseModel):
    installed_skills: list[str]
    graph_template: dict
    template_name: str
    template_description: str
    error: str


class TemplateOut(BaseModel):
    id: str
    name: str
    description: str
    category: str
    required_skills: list[str]


@router.get("", response_model=list[TemplateOut])
def list_templates(
    category: str | None = Query(None),
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """List available workflow templates."""
    svc = WorkflowTemplateService(db)
    return svc.list_templates(category=category)


@router.post("/{template_id}/prepare", response_model=TemplatePrepareOut)
def prepare_template(
    template_id: str,
    body: TemplatePrepareIn,
    db: Session = DbSession,
    user: User = CurrentUser,
):
    """Prepare a workflow template: install Skills and return the graph template.

    Does NOT create a WorkflowDefinition — the frontend handles that via the
    normal onCreateDefinition flow (same as local templates like Debate/Consensus).
    """
    svc = WorkflowTemplateService(db)
    result = svc.prepare(
        template_id,
        project_id=body.project_id,
        user_id=user.id,
    )
    if result.error:
        raise HTTPException(422, result.error)
    return result

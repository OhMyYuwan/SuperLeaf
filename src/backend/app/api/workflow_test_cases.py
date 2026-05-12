"""/api/workflows/definitions/{id}/test-cases — reusable fixture storage.

Test cases are lightweight: a name + prompt + arbitrary JSON inputs. The
orchestrator does not know about them — the frontend re-hydrates the test
panel's input state from a saved case and triggers the existing
`/api/workflows/definitions/{id}/execute` endpoint. This keeps test fixtures
orthogonal to the run loop.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Project, User, WorkflowDefinition, WorkflowTestCase
from ..schemas import WorkflowTestCaseIn, WorkflowTestCaseOut
from .deps import get_current_project, get_current_user

router = APIRouter(
    prefix="/api/workflows/definitions/{definition_id}/test-cases",
    tags=["workflow-test-cases"],
)


def _require_definition(
    db: Session, project: Project, definition_id: str, user: User
) -> WorkflowDefinition:
    defn = db.get(WorkflowDefinition, definition_id)
    if defn is None or defn.project_id != project.id or defn.user_id != user.id:
        raise HTTPException(404, "Workflow definition not found")
    return defn


@router.get("", response_model=list[WorkflowTestCaseOut])
def list_cases(
    definition_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> list[WorkflowTestCaseOut]:
    _require_definition(db, project, definition_id, user)
    rows = (
        db.query(WorkflowTestCase)
        .filter(WorkflowTestCase.definition_id == definition_id)
        .order_by(WorkflowTestCase.created_at.asc())
        .all()
    )
    return [WorkflowTestCaseOut.model_validate(r) for r in rows]


@router.post("", response_model=WorkflowTestCaseOut, status_code=201)
def create_case(
    definition_id: str,
    body: WorkflowTestCaseIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> WorkflowTestCaseOut:
    _require_definition(db, project, definition_id, user)
    case = WorkflowTestCase(
        definition_id=definition_id,
        name=body.name,
        prompt=body.prompt,
        inputs=body.inputs or {},
    )
    db.add(case)
    db.commit()
    db.refresh(case)
    return WorkflowTestCaseOut.model_validate(case)


@router.put("/{case_id}", response_model=WorkflowTestCaseOut)
def update_case(
    definition_id: str,
    case_id: str,
    body: WorkflowTestCaseIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> WorkflowTestCaseOut:
    _require_definition(db, project, definition_id, user)
    case = db.get(WorkflowTestCase, case_id)
    if case is None or case.definition_id != definition_id:
        raise HTTPException(404, "Test case not found")
    case.name = body.name
    case.prompt = body.prompt
    case.inputs = body.inputs or {}
    db.commit()
    db.refresh(case)
    return WorkflowTestCaseOut.model_validate(case)


@router.delete("/{case_id}", status_code=204)
def delete_case(
    definition_id: str,
    case_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> None:
    _require_definition(db, project, definition_id, user)
    case = db.get(WorkflowTestCase, case_id)
    if case is None or case.definition_id != definition_id:
        return None
    db.delete(case)
    db.commit()

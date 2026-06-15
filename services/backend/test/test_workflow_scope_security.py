from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import Project, User, WorkflowDefinition, WorkflowRun
from app.services.agent_orchestrator import WorkflowOrchestrator


@pytest.fixture()
def db() -> Iterator[Session]:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture()
def seeded(db: Session) -> dict[str, str]:
    attacker = User(id="attacker", email="attacker@example.com", password_hash="hash")
    victim = User(id="victim", email="victim@example.com", password_hash="hash")
    attacker_project = Project(id="project-a", user_id=attacker.id, name="Project A")
    victim_project = Project(id="project-b", user_id=victim.id, name="Project B")
    db.add_all([attacker, victim, attacker_project, victim_project])
    _add_workflow(db, "victim-wf", project_id=victim_project.id, user_id=victim.id)
    _add_workflow(db, "same-scope-child", project_id=attacker_project.id, user_id=attacker.id)
    _add_workflow(
        db,
        "cross-project-parent",
        project_id=attacker_project.id,
        user_id=attacker.id,
        nested_workflow_id="victim-wf",
    )
    _add_workflow(
        db,
        "same-scope-parent",
        project_id=attacker_project.id,
        user_id=attacker.id,
        nested_workflow_id="same-scope-child",
    )
    db.commit()
    return {"user_id": attacker.id, "project_id": attacker_project.id}


def _add_workflow(
    db: Session,
    workflow_id: str,
    *,
    project_id: str,
    user_id: str,
    nested_workflow_id: str = "",
) -> None:
    graph = {"nodes": [], "edges": []}
    if nested_workflow_id:
        graph = {
            "nodes": [
                {
                    "id": "nested",
                    "type": "workflow",
                    "config": {"workflowDefinitionId": nested_workflow_id},
                }
            ],
            "edges": [],
        }
    db.add(
        WorkflowDefinition(
            id=workflow_id,
            project_id=project_id,
            user_id=user_id,
            name=workflow_id,
            execution_mode="graph",
            graph=graph,
            config={},
        )
    )


async def _collect_events(stream: AsyncIterator[dict]) -> list[dict]:
    events: list[dict] = []
    async for event in stream:
        events.append(event)
    return events


@pytest.mark.asyncio
async def test_orchestrator_rejects_loaded_definition_outside_caller_scope(
    db: Session, seeded: dict[str, str]
) -> None:
    orchestrator = WorkflowOrchestrator(db)

    with pytest.raises(ValueError, match="Workflow definition victim-wf not found"):
        await _collect_events(
            orchestrator.execute_workflow(
                workflow_def_id="victim-wf",
                project_id=seeded["project_id"],
                user_id=seeded["user_id"],
                document_id="doc-a",
                target_text="selection",
                range_start=0,
                range_end=9,
            )
        )


@pytest.mark.asyncio
async def test_nested_workflow_rejects_definition_from_other_project(
    db: Session, seeded: dict[str, str]
) -> None:
    orchestrator = WorkflowOrchestrator(db)

    events = await _collect_events(
        orchestrator.execute_workflow(
            workflow_def_id="cross-project-parent",
            project_id=seeded["project_id"],
            user_id=seeded["user_id"],
            document_id="doc-a",
            target_text="selection",
            range_start=0,
            range_end=9,
        )
    )

    failed = [event for event in events if event["event"] == "node.failed"]
    assert failed
    assert "Workflow definition victim-wf not found" in failed[0]["data"]["error"]
    victim_runs = (
        db.query(WorkflowRun)
        .filter(WorkflowRun.workflow_definition_id == "victim-wf")
        .all()
    )
    assert victim_runs == []


@pytest.mark.asyncio
async def test_nested_workflow_allows_same_project_same_user_reference(
    db: Session, seeded: dict[str, str]
) -> None:
    orchestrator = WorkflowOrchestrator(db)

    events = await _collect_events(
        orchestrator.execute_workflow(
            workflow_def_id="same-scope-parent",
            project_id=seeded["project_id"],
            user_id=seeded["user_id"],
            document_id="doc-a",
            target_text="selection",
            range_start=0,
            range_end=9,
        )
    )

    assert any(event["event"] == "node.completed" for event in events)
    assert any(event["event"] == "workflow.completed" for event in events)
    child_runs = (
        db.query(WorkflowRun)
        .filter(WorkflowRun.workflow_definition_id == "same-scope-child")
        .all()
    )
    assert len(child_runs) == 1

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import conversations, workflows
from app.database import Base
from app.models import CachedWorkflow, Doc, Project, Provider, User
from app.schemas import ConversationCreateIn


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
def seeded(db: Session) -> dict[str, object]:
    attacker = User(id="attacker", email="attacker@example.com", password_hash="hash")
    victim = User(id="victim", email="victim@example.com", password_hash="hash")
    attacker_project = Project(id="project-a", user_id=attacker.id, name="Project A")
    victim_project = Project(id="project-b", user_id=victim.id, name="Project B")
    provider = Provider(
        id="provider-a",
        user_id=attacker.id,
        name="Provider A",
        kind="dify-local",
        endpoint="https://provider.example.test/v1",
        api_key_enc="",
    )
    workflow = CachedWorkflow(
        id="workflow-a",
        user_id=attacker.id,
        provider_id=provider.id,
        external_id="external-workflow-a",
        name="Workflow A",
        kind="workflow",
    )
    db.add_all(
        [
            attacker,
            victim,
            attacker_project,
            victim_project,
            Doc(id="doc-a", project_id=attacker_project.id, folder_id=None, name="a.tex"),
            Doc(id="doc-victim", project_id=victim_project.id, folder_id=None, name="secret.tex"),
            provider,
            workflow,
        ]
    )
    db.commit()
    return {
        "attacker": attacker,
        "project": attacker_project,
    }


def test_create_conversation_rejects_document_from_other_project(
    db: Session, seeded: dict[str, object]
) -> None:
    with pytest.raises(HTTPException) as exc:
        conversations.create_conversation(
            ConversationCreateIn(document_id="doc-victim", workflow_id="workflow-a"),
            db=db,
            project=seeded["project"],  # type: ignore[arg-type]
            user=seeded["attacker"],  # type: ignore[arg-type]
        )

    assert exc.value.status_code == 404
    assert db.query(conversations.Conversation).count() == 0


@pytest.mark.asyncio
async def test_legacy_workflow_run_rejects_document_from_other_project(
    db: Session, seeded: dict[str, object], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(workflows.ProviderService, "make_client", lambda *_args, **_kwargs: object())

    with pytest.raises(HTTPException) as exc:
        await workflows.run_workflow(
            "workflow-a",
            workflows.RunBody(
                document_id="doc-victim",
                range_start=0,
                range_end=1,
                inputs={"source_text": "selection"},
            ),
            db=db,
            project=seeded["project"],  # type: ignore[arg-type]
            user=seeded["attacker"],  # type: ignore[arg-type]
        )

    assert exc.value.status_code == 404

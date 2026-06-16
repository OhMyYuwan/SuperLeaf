from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import annotation_evaluations
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import Annotation, Doc, Project, ProjectMember, User


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
def seeded(db: Session) -> dict[str, User]:
    attacker = User(id="attacker", email="attacker@example.com", password_hash="hash")
    victim = User(id="victim", email="victim@example.com", password_hash="hash")
    victim_project = Project(id="project-a", user_id=victim.id, name="Project A")
    attacker_project = Project(id="project-b", user_id=attacker.id, name="Project B")
    victim_doc = Doc(id="doc-a", project_id=victim_project.id, folder_id=None, name="a.tex")
    attacker_doc = Doc(id="doc-b", project_id=attacker_project.id, folder_id=None, name="b.tex")
    db.add_all(
        [
            attacker,
            victim,
            victim_project,
            attacker_project,
            ProjectMember(project_id=victim_project.id, user_id=attacker.id, role="editor"),
            victim_doc,
            attacker_doc,
            _annotation(
                "ann-victim-project",
                doc_id=victim_doc.id,
                project_id=victim_project.id,
                user_id=victim.id,
                is_global=True,
                content="victim project content",
            ),
            _annotation(
                "ann-victim-private",
                doc_id=victim_doc.id,
                project_id=victim_project.id,
                user_id=victim.id,
                is_global=False,
                content="victim private content",
            ),
            _annotation(
                "ann-attacker",
                doc_id=attacker_doc.id,
                project_id=attacker_project.id,
                user_id=attacker.id,
                is_global=True,
                content="attacker original content",
            ),
        ]
    )
    db.commit()
    return {"attacker": attacker, "victim": victim}


@pytest.fixture()
def attacker_client(db: Session, seeded: dict[str, User]) -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(annotation_evaluations.router)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return seeded["attacker"]

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    with TestClient(app) as client:
        yield client


def test_annotation_upsert_rejects_existing_row_from_other_project(
    db: Session, attacker_client: TestClient
) -> None:
    response = attacker_client.post(
        "/api/annotations/items",
        headers={"X-Project-Id": "project-b"},
        json=_annotation_payload(
            "ann-victim-project",
            doc_id="doc-b",
            content="attacker overwrite",
        ),
    )

    assert response.status_code == 404
    row = db.get(Annotation, "ann-victim-project")
    assert row is not None
    assert row.content == "victim project content"


def test_annotation_upsert_rejects_private_existing_row_from_other_user(
    db: Session, attacker_client: TestClient
) -> None:
    response = attacker_client.post(
        "/api/annotations/items",
        headers={"X-Project-Id": "project-a"},
        json=_annotation_payload(
            "ann-victim-private",
            doc_id="doc-a",
            content="attacker overwrite",
            workflow_id="workflow-a",
            agent_name="Agent",
        ),
    )

    assert response.status_code == 404
    row = db.get(Annotation, "ann-victim-private")
    assert row is not None
    assert row.content == "victim private content"


def test_annotation_upsert_allows_same_user_same_doc_retry(
    db: Session, attacker_client: TestClient
) -> None:
    response = attacker_client.post(
        "/api/annotations/items",
        headers={"X-Project-Id": "project-b"},
        json=_annotation_payload(
            "ann-attacker",
            doc_id="doc-b",
            content="attacker retry content",
        ),
    )

    assert response.status_code == 201
    row = db.get(Annotation, "ann-attacker")
    assert row is not None
    assert row.content == "attacker retry content"


def _annotation(
    annotation_id: str,
    *,
    doc_id: str,
    project_id: str,
    user_id: str,
    is_global: bool,
    content: str,
) -> Annotation:
    return Annotation(
        id=annotation_id,
        doc_id=doc_id,
        project_id=project_id,
        user_id=user_id,
        is_global=is_global,
        kind="annotation",
        status="pending",
        range_from=0,
        range_to=1,
        target_text="x",
        content=content,
        severity="medium",
        created_at=datetime(2026, 6, 15),
    )


def _annotation_payload(
    annotation_id: str,
    *,
    doc_id: str,
    content: str,
    workflow_id: str = "",
    agent_name: str = "",
) -> dict:
    return {
        "id": annotation_id,
        "doc_id": doc_id,
        "kind": "annotation",
        "status": "pending",
        "range_from": 0,
        "range_to": 1,
        "target_text": "x",
        "content": content,
        "severity": "medium",
        "workflow_id": workflow_id,
        "agent_name": agent_name,
        "conversation_id": "",
        "original": "",
        "proposed": "",
        "reason": "",
        "risk_type": "",
        "mitigation": "",
        "thread": [],
        "attached_files": [],
        "created_at": "2026-06-15T00:00:00",
    }

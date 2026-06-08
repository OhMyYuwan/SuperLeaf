from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import annotation_evaluations as annotations_api
from app.api.deps import SESSION_COOKIE_NAME
from app.database import Base
from app.database import get_session as get_db_session
from app.models import (
    Annotation,
    AnnotationAgentSuggestion,
    Doc,
    NativeAgent,
    Project,
    ProjectMember,
    Provider,
    Session,
    User,
)
from app.services.annotation_agent_suggestion_service import compute_annotation_source_hash


def _db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        future=True,
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return session_factory()


def _client(db):
    app = FastAPI()

    def override_session():
        yield db

    app.dependency_overrides[get_db_session] = override_session
    app.include_router(annotations_api.router)
    return TestClient(app)


@pytest.fixture()
def suggestion_fixture():
    db = _db()
    owner = User(id="owner", email="owner@example.com", password_hash="hash")
    editor = User(id="editor", email="editor@example.com", password_hash="hash")
    project = Project(id="project1", user_id=owner.id, name="Project")
    doc = Doc(
        id="doc1",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        content="Intro paragraph. This claim is too broad. Closing.",
    )
    now = datetime.now(UTC).replace(tzinfo=None)
    expires_at = now + timedelta(hours=1)
    global_annotation = Annotation(
        id="global-ann",
        doc_id=doc.id,
        project_id=project.id,
        user_id=editor.id,
        is_global=True,
        kind="user-comment",
        status="pending",
        range_from=17,
        range_to=41,
        target_text="This claim is too broad.",
        content="Please make this claim more specific.",
        severity="medium",
        thread=[],
        created_at=now,
    )
    private_annotation = Annotation(
        id="private-ann",
        doc_id=doc.id,
        project_id=project.id,
        user_id=owner.id,
        is_global=False,
        kind="user-comment",
        status="pending",
        range_from=17,
        range_to=41,
        target_text="This claim is too broad.",
        content="My private note.",
        severity="medium",
        thread=[],
        created_at=now,
    )
    provider = Provider(
        id="provider1",
        user_id=owner.id,
        name="Native Provider",
        kind="native",
        endpoint="http://native.local",
        api_key_enc="",
    )
    native_agent = NativeAgent(
        id="agent1",
        project_id=project.id,
        owner_user_id=owner.id,
        provider_id=provider.id,
        name="Reply Agent",
        model="test-model",
        instructions="Be concise.",
        is_enabled=True,
    )
    db.add_all(
        [
            owner,
            editor,
            project,
            doc,
            ProjectMember(project_id=project.id, user_id=editor.id, role="editor", status="accepted"),
            Session(id="owner-session", user_id=owner.id, expires_at=expires_at),
            Session(id="editor-session", user_id=editor.id, expires_at=expires_at),
            global_annotation,
            private_annotation,
            provider,
            native_agent,
        ]
    )
    db.commit()
    return db, _client(db)


def _set_session(client: TestClient, session_id: str) -> None:
    client.cookies.clear()
    client.cookies.set(SESSION_COOKIE_NAME, session_id)


def _add_suggestion(db, annotation: Annotation, user_id: str, agent_id: str, status: str = "drafted"):
    row = AnnotationAgentSuggestion(
        id=f"sug-{annotation.id}-{user_id}",
        project_id=annotation.project_id,
        doc_id=annotation.doc_id,
        annotation_id=annotation.id,
        user_id=user_id,
        agent_id=agent_id,
        source_hash=compute_annotation_source_hash(annotation),
        status=status,
        suggestions=["建议收窄论述。"],
        internal_meta={},
        error="",
        created_at=datetime.now(UTC).replace(tzinfo=None),
        updated_at=datetime.now(UTC).replace(tzinfo=None),
    )
    db.add(row)
    db.commit()
    return row


def test_agent_suggestions_are_user_private(suggestion_fixture):
    db, client = suggestion_fixture
    ann = db.get(Annotation, "global-ann")
    _add_suggestion(db, ann, "owner", "native:agent1")
    _add_suggestion(db, ann, "editor", "native:someone-else")

    _set_session(client, "owner-session")
    response = client.get(
        "/api/annotations/agent-suggestions/by-doc/doc1",
        headers={"X-Project-Id": "project1"},
    )

    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1
    assert rows[0]["user_id"] == "owner"
    assert rows[0]["agent_id"] == "native:agent1"


def test_annotation_content_change_marks_suggestions_stale(suggestion_fixture):
    db, client = suggestion_fixture
    ann = db.get(Annotation, "global-ann")
    owner_suggestion = _add_suggestion(db, ann, "owner", "native:agent1")
    editor_suggestion = _add_suggestion(db, ann, "editor", "native:editor-agent")

    _set_session(client, "editor-session")
    response = client.patch(
        "/api/annotations/items/global-ann",
        json={"content": "Please narrow this and add evidence."},
        headers={"X-Project-Id": "project1"},
    )

    assert response.status_code == 200
    assert db.get(AnnotationAgentSuggestion, owner_suggestion.id).status == "stale"
    assert db.get(AnnotationAgentSuggestion, editor_suggestion.id).status == "stale"


def test_range_only_patch_does_not_mark_suggestions_stale(suggestion_fixture):
    db, client = suggestion_fixture
    ann = db.get(Annotation, "global-ann")
    suggestion = _add_suggestion(db, ann, "owner", "native:agent1")

    _set_session(client, "owner-session")
    response = client.patch(
        "/api/annotations/items/global-ann",
        json={"range_from": 18, "range_to": 42},
        headers={"X-Project-Id": "project1"},
    )

    assert response.status_code == 200
    assert db.get(AnnotationAgentSuggestion, suggestion.id).status == "drafted"


def test_run_agent_suggestions_processes_and_then_skips_same_hash(monkeypatch, suggestion_fixture):
    db, client = suggestion_fixture

    async def fake_generate(**_kwargs):
        return ["建议补充限定条件。", "可以加一句证据说明。"], {"fake": True}

    monkeypatch.setattr(annotations_api, "_generate_annotation_auto_reply", fake_generate)
    _set_session(client, "owner-session")

    first = client.post(
        "/api/annotations/agent-suggestions/run",
        json={"doc_id": "doc1", "agent_id": "agent1", "include_stale": True},
        headers={"X-Project-Id": "project1"},
    )
    second = client.post(
        "/api/annotations/agent-suggestions/run",
        json={"doc_id": "doc1", "agent_id": "agent1", "include_stale": True},
        headers={"X-Project-Id": "project1"},
    )

    assert first.status_code == 200
    assert first.json()["processed"] == 2
    assert first.json()["failed"] == 0
    assert second.status_code == 200
    assert second.json()["processed"] == 0
    assert second.json()["skipped"] == 2
    rows = (
        db.query(AnnotationAgentSuggestion)
        .filter(AnnotationAgentSuggestion.user_id == "owner")
        .all()
    )
    assert len(rows) == 2

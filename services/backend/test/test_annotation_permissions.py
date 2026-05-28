from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.annotation_evaluations import router as annotations_router
from app.api.deps import SESSION_COOKIE_NAME
from app.database import Base
from app.database import get_session as get_db_session
from app.models import Annotation, Doc, Project, ProjectMember, Session, User


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
    app.include_router(annotations_router)
    return TestClient(app)


@pytest.fixture()
def annotation_fixture():
    db = _db()
    owner = User(id="owner", email="owner@example.com", password_hash="hash")
    editor = User(id="editor", email="editor@example.com", password_hash="hash")
    viewer = User(id="viewer", email="viewer@example.com", password_hash="hash")
    intruder = User(id="intruder", email="intruder@example.com", password_hash="hash")
    project = Project(id="project1", user_id=owner.id, name="Project")
    doc = Doc(id="doc1", project_id=project.id, folder_id=None, name="main.tex", content="hello")
    now = datetime.now(UTC).replace(tzinfo=None)
    expires_at = now + timedelta(hours=1)
    global_annotation = Annotation(
        id="global-ann",
        doc_id=doc.id,
        project_id=project.id,
        user_id=owner.id,
        is_global=True,
        kind="user-comment",
        status="pending",
        range_from=0,
        range_to=5,
        target_text="hello",
        content="Shared note",
        severity="medium",
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
        range_from=0,
        range_to=5,
        target_text="hello",
        content="Private note",
        severity="medium",
        created_at=now,
    )
    db.add_all(
        [
            owner,
            editor,
            viewer,
            intruder,
            project,
            doc,
            ProjectMember(project_id=project.id, user_id=editor.id, role="editor", status="accepted"),
            ProjectMember(project_id=project.id, user_id=viewer.id, role="viewer", status="accepted"),
            Session(id="owner-session", user_id=owner.id, expires_at=expires_at),
            Session(id="editor-session", user_id=editor.id, expires_at=expires_at),
            Session(id="viewer-session", user_id=viewer.id, expires_at=expires_at),
            Session(id="intruder-session", user_id=intruder.id, expires_at=expires_at),
            global_annotation,
            private_annotation,
        ]
    )
    db.commit()
    return db, _client(db)


def _patch(client: TestClient, session_id: str, annotation_id: str, body: dict):
    client.cookies.clear()
    client.cookies.set(SESSION_COOKIE_NAME, session_id)
    return client.patch(
        f"/api/annotations/items/{annotation_id}",
        json=body,
        headers={"X-Project-Id": "project1"},
    )


def test_editor_can_sync_global_annotation_range(annotation_fixture):
    db, client = annotation_fixture

    response = _patch(client, "editor-session", "global-ann", {"range_from": 2, "range_to": 7})

    assert response.status_code == 200
    data = response.json()
    assert data["range_from"] == 2
    assert data["range_to"] == 7
    row = db.get(Annotation, "global-ann")
    assert row.range_from == 2
    assert row.range_to == 7


def test_editor_cannot_change_global_annotation_content(annotation_fixture):
    db, client = annotation_fixture

    response = _patch(client, "editor-session", "global-ann", {"content": "changed"})

    assert response.status_code == 404
    assert db.get(Annotation, "global-ann").content == "Shared note"


def test_editor_cannot_archive_global_annotation(annotation_fixture):
    db, client = annotation_fixture

    response = _patch(client, "editor-session", "global-ann", {"status": "archived"})

    assert response.status_code == 404
    assert db.get(Annotation, "global-ann").status == "pending"


def test_viewer_cannot_sync_global_annotation_range(annotation_fixture):
    db, client = annotation_fixture

    response = _patch(client, "viewer-session", "global-ann", {"range_from": 3, "range_to": 8})

    assert response.status_code == 403
    row = db.get(Annotation, "global-ann")
    assert row.range_from == 0
    assert row.range_to == 5


def test_editor_cannot_sync_private_annotation_range(annotation_fixture):
    db, client = annotation_fixture

    response = _patch(client, "editor-session", "private-ann", {"range_from": 2, "range_to": 7})

    assert response.status_code == 404
    row = db.get(Annotation, "private-ann")
    assert row.range_from == 0
    assert row.range_to == 5


def test_owner_can_change_annotation_content(annotation_fixture):
    db, client = annotation_fixture

    response = _patch(client, "owner-session", "global-ann", {"content": "changed"})

    assert response.status_code == 200
    assert db.get(Annotation, "global-ann").content == "changed"


def test_viewer_cannot_create_annotation(annotation_fixture):
    _db, client = annotation_fixture
    client.cookies.clear()
    client.cookies.set(SESSION_COOKIE_NAME, "viewer-session")

    response = client.post(
        "/api/annotations/items",
        json={
            "id": "new-ann",
            "doc_id": "doc1",
            "kind": "user-comment",
            "status": "pending",
            "range_from": 0,
            "range_to": 5,
            "target_text": "hello",
            "content": "Nope",
            "severity": "medium",
            "created_at": datetime.now(UTC).isoformat(),
        },
        headers={"X-Project-Id": "project1"},
    )

    assert response.status_code == 403

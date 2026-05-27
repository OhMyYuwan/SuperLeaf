from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.auth import router as auth_router
from app.api.deps import SESSION_COOKIE_NAME
from app.api.filesystem import router as filesystem_router
from app.database import Base
from app.database import get_session as get_db_session
from app.models import Doc, Project, ProjectMember, Session, User
from app.settings import settings


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
    app.include_router(auth_router)
    app.include_router(filesystem_router)
    return TestClient(app)


@pytest.fixture()
def collab_fixture(monkeypatch):
    monkeypatch.setattr(settings, "collab_token_lifetime_seconds", 30)
    db = _db()
    owner = User(id="owner", email="owner@example.com", password_hash="hash")
    member = User(id="member", email="member@example.com", password_hash="hash")
    intruder = User(id="intruder", email="intruder@example.com", password_hash="hash")
    project = Project(id="project1", user_id=owner.id, name="Project")
    other_project = Project(id="project2", user_id=owner.id, name="Other")
    doc = Doc(id="doc1", project_id=project.id, folder_id=None, name="main.tex", content="hello")
    other_doc = Doc(id="doc2", project_id=other_project.id, folder_id=None, name="other.tex", content="other")
    membership = ProjectMember(
        project_id=project.id,
        user_id=member.id,
        role="viewer",
        status="accepted",
    )
    expires_at = datetime.utcnow() + timedelta(hours=1)
    db.add_all(
        [
            owner,
            member,
            intruder,
            project,
            other_project,
            doc,
            other_doc,
            membership,
            Session(id="owner-session", user_id=owner.id, expires_at=expires_at),
            Session(id="member-session", user_id=member.id, expires_at=expires_at),
            Session(id="intruder-session", user_id=intruder.id, expires_at=expires_at),
        ]
    )
    db.commit()
    return db, _client(db)


def _issue_token(client: TestClient, session_id: str = "owner-session", doc_id: str = "doc1") -> str:
    client.cookies.clear()
    client.cookies.set(SESSION_COOKIE_NAME, session_id)
    response = client.get("/api/auth/collab-token", params={"doc_id": doc_id})
    assert response.status_code == 200
    token = response.json()["token"]
    assert token
    return token


def test_collab_token_is_not_the_session_id(collab_fixture):
    _db, client = collab_fixture

    token = _issue_token(client)

    assert token != "owner-session"


def test_collab_verify_rejects_query_parameter_token(collab_fixture):
    _db, client = collab_fixture
    token = _issue_token(client)
    client.cookies.clear()

    response = client.get("/api/auth/verify", params={"token": token, "doc_id": "doc1"})

    assert response.status_code == 401


def test_collab_verify_accepts_authorization_header(collab_fixture):
    _db, client = collab_fixture
    token = _issue_token(client)
    client.cookies.clear()

    response = client.get(
        "/api/auth/verify",
        params={"doc_id": "doc1"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["user_id"] == "owner"


def test_collab_token_is_bound_to_doc_id(collab_fixture):
    _db, client = collab_fixture
    token = _issue_token(client, doc_id="doc1")
    client.cookies.clear()

    response = client.get(
        "/api/auth/verify",
        params={"doc_id": "doc2"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 401


def test_intruder_cannot_issue_collab_token_for_foreign_doc(collab_fixture):
    _db, client = collab_fixture
    client.cookies.set(SESSION_COOKIE_NAME, "intruder-session")

    response = client.get("/api/auth/collab-token", params={"doc_id": "doc1"})

    assert response.status_code == 404


def test_internal_doc_content_accepts_collab_bearer_token(collab_fixture):
    _db, client = collab_fixture
    token = _issue_token(client)
    client.cookies.clear()

    response = client.get(
        "/api/internal/docs/doc1/content",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["content"] == "hello"


def test_internal_doc_content_rejects_anonymous_request(collab_fixture):
    _db, client = collab_fixture
    client.cookies.clear()

    response = client.get("/api/internal/docs/doc1/content")

    assert response.status_code == 401

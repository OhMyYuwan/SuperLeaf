from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import SESSION_COOKIE_NAME
from app.api.filesystem import router as filesystem_router
from app.database import Base
from app.database import get_session as get_db_session
from app.models import FileBlob, Project, ProjectMember, Session, User


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
    app.include_router(filesystem_router)
    return TestClient(app)


@pytest.fixture()
def file_download_fixture():
    db = _db()
    owner = User(id="owner", email="owner@example.com", password_hash="hash")
    member = User(id="member", email="member@example.com", password_hash="hash")
    intruder = User(id="intruder", email="intruder@example.com", password_hash="hash")
    project = Project(id="project1", user_id=owner.id, name="Project")
    file = FileBlob(
        id="file1",
        project_id=project.id,
        folder_id=None,
        name="figure.png",
        mime_type="image/png",
        blob=b"image-bytes",
    )
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
            file,
            membership,
            Session(id="owner-session", user_id=owner.id, expires_at=expires_at),
            Session(id="member-session", user_id=member.id, expires_at=expires_at),
            Session(id="intruder-session", user_id=intruder.id, expires_at=expires_at),
        ]
    )
    db.commit()
    return db, _client(db)


def test_file_download_requires_authentication(file_download_fixture):
    _db, client = file_download_fixture

    response = client.get("/api/files/file1")

    assert response.status_code == 401


def test_file_download_hides_file_from_non_member(file_download_fixture):
    _db, client = file_download_fixture

    response = client.get(
        "/api/files/file1",
        cookies={SESSION_COOKIE_NAME: "intruder-session"},
    )

    assert response.status_code == 404


def test_file_download_allows_project_owner(file_download_fixture):
    _db, client = file_download_fixture

    response = client.get(
        "/api/files/file1",
        cookies={SESSION_COOKIE_NAME: "owner-session"},
    )

    assert response.status_code == 200
    assert response.content == b"image-bytes"
    assert response.headers["content-type"].startswith("image/png")
    assert "inline" in response.headers["content-disposition"]


def test_file_download_allows_project_member(file_download_fixture):
    _db, client = file_download_fixture

    response = client.get(
        "/api/files/file1",
        cookies={SESSION_COOKIE_NAME: "member-session"},
    )

    assert response.status_code == 200
    assert response.content == b"image-bytes"

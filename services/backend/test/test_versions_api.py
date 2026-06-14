from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import versions
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import Blob, Doc, DocumentVersion, Project, User


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
def client(db: Session) -> Iterator[TestClient]:
    user = User(id="owner", email="owner@example.com", password_hash="hash")
    project = Project(id="project-a", user_id=user.id, name="Project A")
    doc = Doc(id="doc-a", project_id=project.id, folder_id=None, name="main.tex", content="current")
    blob = Blob(
        hash="a" * 40,
        content=b"prefix \xa3 suffix",
        byte_length=15,
        string_length=15,
    )
    version = DocumentVersion(
        id="version-a",
        doc_id=doc.id,
        version=1,
        blob_hash=blob.hash,
        origin="manual",
    )
    db.add_all([user, project, doc, blob, version])
    db.commit()

    app = FastAPI()
    app.include_router(versions.router)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return user

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def test_restore_legacy_text_blob_with_invalid_utf8_skips_bad_bytes(
    db: Session,
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(versions, "flush_project_collab_or_503_sync", lambda _project: ["doc-a"])
    monkeypatch.setattr(
        versions,
        "sync_collab_doc_from_db_or_503_sync",
        lambda *_args, **_kwargs: None,
    )

    response = client.post(
        "/api/docs/doc-a/restore/1",
        headers={"X-Project-Id": "project-a"},
    )

    assert response.status_code == 200
    assert response.json()["content"] == "prefix  suffix"
    db.expire_all()
    assert db.get(Doc, "doc-a").content == "prefix  suffix"


def test_get_legacy_text_blob_with_invalid_utf8_skips_bad_bytes(
    client: TestClient,
) -> None:
    response = client.get(
        "/api/docs/doc-a/versions/1",
        headers={"X-Project-Id": "project-a"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["binary"] is False
    assert body["content"] == "prefix  suffix"

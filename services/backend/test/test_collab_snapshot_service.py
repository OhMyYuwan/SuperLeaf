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
from app.models import Doc, Project, User
from app.models import Session as AuthSession
from app.services import collab_snapshot_service


def _session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        future=True,
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def _seed_doc(session_factory, *, content: str = "not empty") -> None:
    db = session_factory()
    user = User(id="owner", email="owner@example.com", password_hash="hash")
    project = Project(id="project1", user_id=user.id, name="Project")
    expires_at = datetime.utcnow() + timedelta(hours=1)
    doc = Doc(
        id="doc1",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content=content,
        version=1,
    )
    session = AuthSession(id="owner-session", user_id=user.id, expires_at=expires_at)
    db.add_all([user, project, doc, session])
    db.commit()
    db.close()


def _client(db) -> TestClient:
    app = FastAPI()

    def override_session():
        yield db

    app.dependency_overrides[get_db_session] = override_session
    app.include_router(filesystem_router)
    return TestClient(app)


class _FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


@pytest.mark.asyncio
async def test_fetch_active_doc_ids_reads_collab_server(monkeypatch):
    seen = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url, headers=None):
            seen["url"] = url
            seen["headers"] = headers
            return _FakeResponse({"doc_ids": ["doc1", "", None, "doc2"]})

    monkeypatch.setattr(collab_snapshot_service.httpx, "AsyncClient", FakeClient)

    doc_ids = await collab_snapshot_service._fetch_active_doc_ids("http://collab/")

    assert doc_ids == ["doc1", "doc2"]
    assert seen["url"] == "http://collab/docs/active"


@pytest.mark.asyncio
async def test_snapshot_active_docs_uses_collab_active_list(monkeypatch):
    calls = []

    async def fake_fetch_active_doc_ids(base_url):
        return ["doc1"]

    async def fake_snapshot_doc_from_collab(doc_id, *, base_url=None):
        calls.append((doc_id, base_url))
        return object()

    monkeypatch.setattr(collab_snapshot_service, "_fetch_active_doc_ids", fake_fetch_active_doc_ids)
    monkeypatch.setattr(collab_snapshot_service, "snapshot_doc_from_collab", fake_snapshot_doc_from_collab)

    await collab_snapshot_service._snapshot_active_docs("http://collab")

    assert calls == [("doc1", "http://collab")]


@pytest.mark.asyncio
async def test_snapshot_doc_from_collab_accepts_empty_text(monkeypatch):
    session_factory = _session_factory()
    _seed_doc(session_factory, content="not empty")
    monkeypatch.setattr(collab_snapshot_service, "SessionLocal", session_factory)

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url, headers=None):
            return _FakeResponse({"doc_id": "doc1", "text": "", "length": 0})

    monkeypatch.setattr(collab_snapshot_service.httpx, "AsyncClient", FakeClient)

    updated = await collab_snapshot_service.snapshot_doc_from_collab("doc1", base_url="http://collab")

    assert updated is not None
    assert updated.content == ""
    assert updated.version == 2

    db = session_factory()
    persisted = db.get(Doc, "doc1")
    assert persisted is not None
    assert persisted.content == ""
    assert persisted.version == 2
    db.close()


def test_collab_flush_endpoint_returns_snapshotted_doc(monkeypatch):
    session_factory = _session_factory()
    _seed_doc(session_factory, content="old")
    db = session_factory()
    client = _client(db)

    async def fake_snapshot_doc_from_collab(doc_id, *, base_url=None):
        doc = db.get(Doc, doc_id)
        assert doc is not None
        doc.content = "from yjs"
        doc.version = 2
        db.commit()
        db.refresh(doc)
        return doc

    monkeypatch.setattr(
        collab_snapshot_service,
        "snapshot_doc_from_collab",
        fake_snapshot_doc_from_collab,
    )

    response = client.post(
        "/api/docs/doc1/collab-flush",
        cookies={SESSION_COOKIE_NAME: "owner-session"},
        headers={"X-Project-Id": "project1", "X-Client-Id": "client-a"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["content"] == "from yjs"
    assert payload["version"] == 2
    db.close()

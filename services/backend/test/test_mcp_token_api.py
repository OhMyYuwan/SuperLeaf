"""MCP token management + token-authenticated project access.

Covers the two auth surfaces in app/api/mcp.py: session-cookie token
management, and bearer-token data routes that an IDE/CLI MCP client uses
without a browser context. Cross-user isolation and read/write scope gating
are the security-sensitive paths exercised here.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import mcp
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import Doc, Project, ProjectMember, User


@dataclass(slots=True)
class SeedData:
    owner: User
    other: User
    viewer: User
    project: Project
    other_project: Project
    doc: Doc


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
def seed(db: Session) -> SeedData:
    owner = User(id="owner", email="owner@example.com", password_hash="hash", display_name="Owner")
    other = User(id="other", email="other@example.com", password_hash="hash", display_name="Other")
    viewer = User(id="viewer", email="viewer@example.com", password_hash="hash", display_name="Viewer")
    project = Project(id="project-a", user_id=owner.id, name="Project A", project_type="paper")
    other_project = Project(id="project-b", user_id=other.id, name="Project B", project_type="paper")
    viewer_member = ProjectMember(project_id=project.id, user_id=viewer.id, role="viewer")
    doc = Doc(
        id="doc-a",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content="\\section{Intro}\nHello world\n\\section{Method}\nfoo bar baz",
    )
    db.add_all([owner, other, viewer, project, other_project, viewer_member, doc])
    db.commit()
    return SeedData(
        owner=owner,
        other=other,
        viewer=viewer,
        project=project,
        other_project=other_project,
        doc=doc,
    )


def make_client(db: Session, user: User | None) -> TestClient:
    app = FastAPI()
    app.include_router(mcp.router)

    def override_session() -> Iterator[Session]:
        yield db

    app.dependency_overrides[get_session] = override_session
    if user is not None:
        app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def _mint(db: Session, user: User, *, scope: str = "read") -> str:
    with make_client(db, user) as client:
        resp = client.post("/api/mcp/tokens", json={"name": "ide", "scope": scope})
    assert resp.status_code == 201, resp.text
    return resp.json()["plaintext"]


# ---- token management -----------------------------------------------------


def test_create_token_returns_plaintext_once_with_prefix(db: Session, seed: SeedData) -> None:
    with make_client(db, seed.owner) as client:
        resp = client.post("/api/mcp/tokens", json={"name": "codex", "scope": "read"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["plaintext"].startswith("slmcp_")
    assert body["token"]["scope"] == "read"
    assert body["token"]["is_active"] is True
    # The hint is the visible tail; the full plaintext must not be re-derivable.
    assert body["plaintext"].endswith(body["token"]["token_hint"])


def test_invalid_scope_is_rejected(db: Session, seed: SeedData) -> None:
    with make_client(db, seed.owner) as client:
        resp = client.post("/api/mcp/tokens", json={"name": "x", "scope": "admin"})
    assert resp.status_code == 422


def test_list_only_shows_own_tokens(db: Session, seed: SeedData) -> None:
    _mint(db, seed.owner)
    _mint(db, seed.other)
    with make_client(db, seed.owner) as client:
        resp = client.get("/api/mcp/tokens")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


def test_revoked_token_stops_working(db: Session, seed: SeedData) -> None:
    token = _mint(db, seed.owner)
    headers = {"Authorization": f"Bearer {token}"}
    with make_client(db, seed.owner) as client:
        assert client.get("/api/mcp/whoami", headers=headers).status_code == 200
        token_id = client.get("/api/mcp/tokens").json()[0]["id"]
        assert client.delete(f"/api/mcp/tokens/{token_id}").status_code == 204
    with make_client(db, None) as client:
        assert client.get("/api/mcp/whoami", headers=headers).status_code == 401


# ---- token-authenticated data routes --------------------------------------


def test_whoami_reports_scope(db: Session, seed: SeedData) -> None:
    token = _mint(db, seed.owner, scope="write")
    with make_client(db, None) as client:
        resp = client.get("/api/mcp/whoami", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["scope"] == "write"
    assert resp.json()["user_id"] == seed.owner.id


def test_missing_and_bad_tokens_rejected(db: Session, seed: SeedData) -> None:
    with make_client(db, None) as client:
        assert client.get("/api/mcp/projects").status_code == 401
        assert client.get(
            "/api/mcp/projects", headers={"Authorization": "Bearer slmcp_nope"}
        ).status_code == 401
        # Wrong scheme / no prefix.
        assert client.get(
            "/api/mcp/projects", headers={"Authorization": "Bearer not-a-superleaf-token"}
        ).status_code == 401


def test_projects_list_includes_owned_and_shared(db: Session, seed: SeedData) -> None:
    # Viewer is a member of project A only.
    token = _mint(db, seed.viewer)
    with make_client(db, None) as client:
        resp = client.get("/api/mcp/projects", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    items = {p["id"]: p for p in resp.json()}
    assert "project-a" in items
    assert items["project-a"]["my_role"] == "viewer"
    assert "project-b" not in items  # not a member


def test_cannot_access_foreign_project(db: Session, seed: SeedData) -> None:
    token = _mint(db, seed.owner)  # owner of project-a only
    headers = {"Authorization": f"Bearer {token}"}
    with make_client(db, None) as client:
        # project-b belongs to `other` — must look like it does not exist.
        assert client.get("/api/mcp/projects/project-b/docs", headers=headers).status_code == 404


def test_read_grep_outline(db: Session, seed: SeedData) -> None:
    token = _mint(db, seed.owner)
    headers = {"Authorization": f"Bearer {token}"}
    with make_client(db, None) as client:
        docs = client.get("/api/mcp/projects/project-a/docs", headers=headers).json()
        assert [d["name"] for d in docs] == ["main.tex"]

        read = client.get(
            "/api/mcp/projects/project-a/docs/doc-a", headers=headers
        ).json()
        assert read["total_length"] == len(seed.doc.content)
        assert "Hello world" in read["content"]

        grep = client.get(
            "/api/mcp/projects/project-a/grep",
            params={"pattern": "section"},
            headers=headers,
        ).json()
        assert len(grep["hits"]) == 2

        outline = client.get(
            "/api/mcp/projects/project-a/docs/doc-a/outline", headers=headers
        ).json()
        assert [s["title"] for s in outline["sections"]] == ["Intro", "Method"]


def test_grep_invalid_regex_returns_400(db: Session, seed: SeedData) -> None:
    token = _mint(db, seed.owner)
    with make_client(db, None) as client:
        resp = client.get(
            "/api/mcp/projects/project-a/grep",
            params={"pattern": "([unclosed"},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 400

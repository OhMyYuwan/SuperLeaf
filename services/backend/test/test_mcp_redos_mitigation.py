"""Test ReDoS mitigation in /api/mcp/projects/{id}/grep endpoint."""

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
from app.models import Doc, Project, User
from app.services.mcp_token_service import McpTokenService


@dataclass(slots=True)
class SeedData:
    owner: User
    project: Project
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
    project = Project(id="project-a", user_id=owner.id, name="Project A", project_type="paper")
    doc = Doc(
        id="doc-a",
        project_id=project.id,
        name="main.tex",
        format="tex",
        content="\\section{Intro}\nHello world\n\\section{Method}\nfoo bar baz",
    )
    db.add_all([owner, project, doc])
    db.commit()
    return SeedData(owner=owner, project=project, doc=doc)


@pytest.fixture()
def client(db: Session, seed: SeedData) -> TestClient:
    app = FastAPI()
    app.include_router(mcp.router)

    def override_session():
        yield db

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = lambda: seed.owner
    return TestClient(app)


@pytest.fixture()
def mcp_token(db: Session, seed: SeedData) -> str:
    svc = McpTokenService(db)
    row, plaintext = svc.create_token(user_id=seed.owner.id, name="test", scope="read", expires_in_days=1)
    return plaintext


def test_grep_rejects_overly_long_pattern(client: TestClient, mcp_token: str, seed: SeedData):
    """Pattern longer than _GREP_MAX_PATTERN_LENGTH (500) should be rejected."""
    long_pattern = "a" * 501
    resp = client.get(
        f"/api/mcp/projects/{seed.project.id}/grep",
        params={"pattern": long_pattern},
        headers={"Authorization": f"Bearer {mcp_token}"},
    )
    assert resp.status_code == 400
    assert "too long" in resp.json()["detail"].lower()


def test_grep_rejects_nested_quantifier_patterns(client: TestClient, mcp_token: str, seed: SeedData):
    """Nested quantifiers like (a+)+ should be rejected (ReDoS risk)."""
    dangerous_patterns = [
        "(a+)+",  # classic ReDoS
        "(a*)+",
        "(a+)*",
        "([ab]+)+",
    ]
    for pattern in dangerous_patterns:
        resp = client.get(
            f"/api/mcp/projects/{seed.project.id}/grep",
            params={"pattern": pattern},
            headers={"Authorization": f"Bearer {mcp_token}"},
        )
        assert resp.status_code == 400, f"Pattern {pattern} should be rejected"
        detail = resp.json()["detail"].lower()
        assert "catastrophic backtracking" in detail or "rejected" in detail


def test_grep_allows_safe_patterns(client: TestClient, mcp_token: str, seed: SeedData):
    """Common safe patterns should still work."""
    safe_patterns = [
        r"\bworld\b",
        r"section",
        r"[a-z]+",
        r"(foo|bar)",
        r"\d{3}-\d{4}",
    ]
    for pattern in safe_patterns:
        resp = client.get(
            f"/api/mcp/projects/{seed.project.id}/grep",
            params={"pattern": pattern},
            headers={"Authorization": f"Bearer {mcp_token}"},
        )
        # Should succeed (200) or find no hits, but not reject pattern
        assert resp.status_code == 200, f"Safe pattern {pattern} was incorrectly rejected: {resp.json()}"


def test_grep_skips_huge_documents(client: TestClient, mcp_token: str, seed: SeedData, db: Session):
    """Documents exceeding _GREP_MAX_DOC_CHARS (500k) should be skipped silently."""
    # Create a huge document
    huge_content = "x" * 600_000  # exceeds 500k limit
    huge_doc = Doc(
        id="huge-doc",
        project_id=seed.project.id,
        name="huge.txt",
        format="txt",
        content=huge_content,
    )
    db.add(huge_doc)
    db.commit()

    # Grep should skip it without error
    resp = client.get(
        f"/api/mcp/projects/{seed.project.id}/grep",
        params={"pattern": "x"},
        headers={"Authorization": f"Bearer {mcp_token}"},
    )
    assert resp.status_code == 200
    # The huge doc should not appear in hits (it was skipped)
    hits = resp.json()["hits"]
    assert all(h["doc_id"] != huge_doc.id for h in hits), "Huge document should be skipped"

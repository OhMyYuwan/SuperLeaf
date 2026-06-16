from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import Doc, Project, User
from app.services import native_agent_tool_kernel as kernel
from app.services.native_agent_tool_kernel import (
    NativeAgentToolContext,
    NativeAgentToolResult,
    execute_native_agent_db_tool,
)


@dataclass(frozen=True)
class SeedData:
    project: Project
    safe_doc: Doc
    huge_doc: Doc


@pytest.fixture()
def db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Session]:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(kernel, "SessionLocal", SessionLocal)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture()
def seed(db: Session) -> SeedData:
    user = User(id="user-a", email="user@example.com", password_hash="hash")
    project = Project(id="project-a", user_id=user.id, name="Paper", project_type="paper")
    safe_doc = Doc(
        id="doc-safe",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content="\\section{Intro}\nHello\n\\section{Method}\nWorld",
    )
    huge_doc = Doc(
        id="doc-huge",
        project_id=project.id,
        folder_id=None,
        name="huge.tex",
        format="tex",
        content="needle\n" + ("x" * 500_001),
    )
    db.add_all([user, project, safe_doc, huge_doc])
    db.commit()
    return SeedData(project=project, safe_doc=safe_doc, huge_doc=huge_doc)


def test_native_project_grep_rejects_dangerous_nested_quantifier(seed: SeedData) -> None:
    result = _grep(seed, {"pattern": "(a+)+"})

    assert result.failed is True
    assert "catastrophic" in result.content.lower()


def test_native_project_grep_rejects_overlong_pattern(seed: SeedData) -> None:
    result = _grep(seed, {"pattern": "x" * 501})

    assert result.failed is True
    assert "too long" in result.content.lower()


def test_native_project_grep_skips_oversized_documents(seed: SeedData) -> None:
    result = _grep(seed, {"pattern": "needle"})
    body = json.loads(result.content)

    assert result.failed is False
    assert body["hits"] == []


def test_native_project_grep_safe_pattern_still_returns_hits(seed: SeedData) -> None:
    result = _grep(seed, {"pattern": "section"})
    body = json.loads(result.content)

    assert result.failed is False
    assert [hit["doc_name"] for hit in body["hits"]] == ["main.tex", "main.tex"]


def _grep(seed: SeedData, args: dict[str, object]) -> NativeAgentToolResult:
    result = execute_native_agent_db_tool(
        "project_grep",
        args,
        NativeAgentToolContext(project_id=seed.project.id, user_id="user-a"),
    )
    assert result is not None
    return result

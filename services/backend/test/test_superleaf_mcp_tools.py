"""Backend-native SuperLeaf MCP tool execution service."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import Doc, McpToken, Project, ProjectMember, User
from app.services.mcp_token_service import McpTokenService
from app.services.superleaf_mcp_tools import (
    SuperleafMcpToolContext,
    call_superleaf_mcp_tool,
)


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


def _ctx(db: Session, user: User, *, scope: str = "read") -> SuperleafMcpToolContext:
    row, _plaintext = McpTokenService(db).create_token(
        user_id=user.id,
        name="test",
        scope=scope,
        expires_in_days=1,
    )
    return SuperleafMcpToolContext(user=user, token=row)


def _call(
    db: Session,
    ctx: SuperleafMcpToolContext,
    name: str,
    arguments: dict | None = None,
) -> tuple[dict, SuperleafMcpToolContext]:
    text, next_ctx = call_superleaf_mcp_tool(db, ctx, name, arguments or {})
    return json.loads(text), next_ctx


def test_list_projects_includes_owned_and_shared_only(
    db: Session,
    seed: SeedData,
) -> None:
    body, _ctx_after = _call(db, _ctx(db, seed.viewer), "superleaf_list_projects")

    projects = {item["id"]: item for item in body["projects"]}
    assert "project-a" in projects
    assert projects["project-a"]["my_role"] == "viewer"
    assert "project-b" not in projects


def test_select_project_updates_context_and_list_docs_can_use_it(
    db: Session,
    seed: SeedData,
) -> None:
    ctx = _ctx(db, seed.owner)
    selected, ctx = _call(
        db,
        ctx,
        "superleaf_select_project",
        {"project_id": seed.project.id},
    )
    assert selected["project"]["id"] == seed.project.id
    assert ctx.active_project_id == seed.project.id

    body, _ctx_after = _call(db, ctx, "project_list_docs")
    assert [doc["name"] for doc in body["docs"]] == ["main.tex"]


def test_read_doc_caps_default_content_range(
    db: Session,
    seed: SeedData,
) -> None:
    long_doc = Doc(
        id="long-doc",
        project_id=seed.project.id,
        folder_id=None,
        name="long.tex",
        format="tex",
        content="x" * 25_000,
    )
    db.add(long_doc)
    db.commit()

    body, _ctx_after = _call(
        db,
        _ctx(db, seed.owner),
        "project_read_doc",
        {"project_id": seed.project.id, "doc_id": long_doc.id},
    )

    assert body["total_length"] == 25_000
    assert body["range_end"] == 20_000
    assert len(body["content"]) == 20_000
    assert body["truncated"] is True


def test_grep_rejects_expensive_patterns(
    db: Session,
    seed: SeedData,
) -> None:
    ctx = _ctx(db, seed.owner)
    with pytest.raises(HTTPException) as too_long:
        call_superleaf_mcp_tool(
            db,
            ctx,
            "project_grep",
            {"project_id": seed.project.id, "pattern": "x" * 501},
        )
    assert too_long.value.status_code == 400

    with pytest.raises(HTTPException) as nested:
        call_superleaf_mcp_tool(
            db,
            ctx,
            "project_grep",
            {"project_id": seed.project.id, "pattern": "(a+)+"},
        )
    assert nested.value.status_code == 400


def test_grep_and_outline_return_document_context(
    db: Session,
    seed: SeedData,
) -> None:
    grep, _ctx_after = _call(
        db,
        _ctx(db, seed.owner),
        "project_grep",
        {"project_id": seed.project.id, "pattern": "section"},
    )
    assert len(grep["hits"]) == 2
    assert grep["hits"][0]["doc_name"] == "main.tex"

    outline, _ctx_after = _call(
        db,
        _ctx(db, seed.owner),
        "project_outline",
        {"project_id": seed.project.id, "doc_id": seed.doc.id},
    )
    assert [section["title"] for section in outline["sections"]] == ["Intro", "Method"]


def test_foreign_project_is_not_visible_to_tool_context(
    db: Session,
    seed: SeedData,
) -> None:
    with pytest.raises(HTTPException) as exc:
        call_superleaf_mcp_tool(
            db,
            _ctx(db, seed.owner),
            "project_list_docs",
            {"project_id": seed.other_project.id},
        )
    assert exc.value.status_code == 404


def test_unknown_tool_is_rejected(
    db: Session,
    seed: SeedData,
) -> None:
    with pytest.raises(HTTPException) as exc:
        call_superleaf_mcp_tool(db, _ctx(db, seed.owner), "not_a_tool", {})
    assert exc.value.status_code == 400

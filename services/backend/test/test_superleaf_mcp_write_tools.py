"""Write-capable backend-native SuperLeaf MCP tools."""

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
from app.models import Annotation, Doc, Project, User
from app.services.mcp_token_service import McpTokenService
from app.services.superleaf_mcp_tools import (
    SuperleafMcpToolContext,
    call_superleaf_mcp_tool,
)


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
        folder_id=None,
        name="main.tex",
        format="tex",
        content="\\section{Intro}\nHello world\n",
    )
    db.add_all([owner, project, doc])
    db.commit()
    return SeedData(owner=owner, project=project, doc=doc)


def _ctx(db: Session, user: User, *, scope: str = "write") -> SuperleafMcpToolContext:
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
    arguments: dict,
) -> tuple[dict, SuperleafMcpToolContext]:
    text, next_ctx = call_superleaf_mcp_tool(db, ctx, name, arguments)
    return json.loads(text), next_ctx


def test_read_token_cannot_create_edit_proposal(
    db: Session,
    seed: SeedData,
) -> None:
    with pytest.raises(HTTPException) as exc:
        call_superleaf_mcp_tool(
            db,
            _ctx(db, seed.owner, scope="read"),
            "propose_doc_edit",
            {
                "project_id": seed.project.id,
                "doc_id": seed.doc.id,
                "range_start": 16,
                "range_end": 27,
                "new_text": "Hello, world!",
            },
        )
    assert exc.value.status_code == 403


def test_propose_doc_edit_creates_pending_annotation_without_mutating_doc(
    db: Session,
    seed: SeedData,
) -> None:
    body, _ctx_after = _call(
        db,
        _ctx(db, seed.owner),
        "propose_doc_edit",
        {
            "project_id": seed.project.id,
            "doc_id": seed.doc.id,
            "original_text": "Hello world",
            "range_start": 16,
            "range_end": 27,
            "new_text": "Hello, world!",
            "reason": "Add punctuation.",
        },
    )

    annotation = db.get(Annotation, body["proposal_id"])
    assert body["status"] == "proposed"
    assert annotation is not None
    assert annotation.kind == "suggestion"
    assert annotation.status == "pending"
    assert annotation.original == "Hello world"
    assert annotation.proposed == "Hello, world!"
    assert annotation.reason == "Add punctuation."
    assert annotation.target_text == "Hello world"
    assert body["range_start"] == 16
    assert body["range_end"] == 27
    assert body["anchor_status"] == "stable"
    assert db.get(Doc, seed.doc.id).content == "\\section{Intro}\nHello world\n"


def test_create_suggestion_creates_annotation_card(
    db: Session,
    seed: SeedData,
) -> None:
    body, _ctx_after = _call(
        db,
        _ctx(db, seed.owner),
        "create_suggestion",
        {
            "project_id": seed.project.id,
            "doc_id": seed.doc.id,
            "original_text": "Hello world",
            "content": "Consider a more formal greeting.",
            "proposed_text": "Hello, world!",
            "reason": "Tone polish.",
        },
    )

    annotation = db.get(Annotation, body["suggestion_id"])
    assert body["status"] == "created"
    assert annotation is not None
    assert annotation.kind == "suggestion"
    assert annotation.content == "Consider a more formal greeting."
    assert annotation.original == "Hello world"
    assert annotation.proposed == "Hello, world!"
    assert body["range_start"] == 16
    assert body["range_end"] == 27
    assert body["anchor_status"] == "recovered"


def test_project_write_text_file_creates_nested_doc(
    db: Session,
    seed: SeedData,
) -> None:
    body, _ctx_after = _call(
        db,
        _ctx(db, seed.owner),
        "project_write_text_file",
        {
            "project_id": seed.project.id,
            "path": "notes/review.md",
            "content": "# Review\n\nLooks good.\n",
        },
    )

    doc = db.get(Doc, body["doc_id"])
    assert body["status"] == "created"
    assert body["path"] == "notes/review.md"
    assert doc is not None
    assert doc.name == "review.md"
    assert doc.format == "md"
    assert doc.content == "# Review\n\nLooks good.\n"


def test_project_write_text_file_refuses_overwrite(
    db: Session,
    seed: SeedData,
) -> None:
    ctx = _ctx(db, seed.owner)
    args = {
        "project_id": seed.project.id,
        "path": "notes/review.md",
        "content": "# Review\n",
    }
    _call(db, ctx, "project_create_text_file", args)

    with pytest.raises(HTTPException) as exc:
        call_superleaf_mcp_tool(db, ctx, "project_write_text_file", args)
    assert exc.value.status_code == 409

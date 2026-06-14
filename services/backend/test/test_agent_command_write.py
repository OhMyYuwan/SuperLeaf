"""Write-capable Agent command behavior."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.agent_commands.context import AgentCommandContext, AgentCommandSource
from app.agent_commands.executor import AgentCommandExecutor
from app.database import Base
from app.models import Annotation, Doc, Project, User


@pytest.fixture()
def db() -> Iterator[Session]:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture()
def seed(db: Session) -> dict[str, User | Project | Doc]:
    owner = User(id="owner", email="owner@example.com", password_hash="hash", display_name="Owner")
    project = Project(id="project-a", user_id=owner.id, name="Paper", project_type="paper")
    doc = Doc(
        id="doc-a",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content="\\section{Intro}\nHello",
    )
    db.add_all([owner, project, doc])
    db.commit()
    return {"owner": owner, "project": project, "doc": doc}


def test_read_scope_cannot_create_proposal(db: Session, seed: dict[str, User | Project | Doc]) -> None:
    owner = seed["owner"]
    assert isinstance(owner, User)
    ctx = AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=owner.id,
        token_scope="read",
        active_project_id="project-a",
    )

    with pytest.raises(HTTPException) as exc:
        AgentCommandExecutor().execute(
            db,
            ctx,
            "propose_doc_edit",
            {"doc_id": "doc-a", "range_start": 0, "range_end": 5, "new_text": "Hello"},
        )

    assert "read-only" in str(exc.value.detail).lower()


def test_write_scope_creates_proposal_without_mutating_doc(
    db: Session,
    seed: dict[str, User | Project | Doc],
) -> None:
    owner = seed["owner"]
    doc = seed["doc"]
    assert isinstance(owner, User)
    assert isinstance(doc, Doc)
    ctx = AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=owner.id,
        token_scope="write",
        active_project_id="project-a",
    )

    result = AgentCommandExecutor().execute(
        db,
        ctx,
        "propose_doc_edit",
        {
            "doc_id": "doc-a",
            "original_text": "Hello",
            "range_start": 16,
            "range_end": 21,
            "new_text": "Hello, world",
            "reason": "polish",
        },
    )

    annotation = db.get(Annotation, result.payload["proposal_id"])
    assert annotation is not None
    assert annotation.kind == "suggestion"
    assert annotation.status == "pending"
    assert annotation.proposed == "Hello, world"
    assert doc.content.endswith("Hello")
    assert result.payload["range_start"] == 16
    assert result.payload["range_end"] == 21
    assert result.payload["anchor_status"] == "stable"


def test_propose_doc_edit_relocates_stale_range_with_original_text(
    db: Session,
    seed: dict[str, User | Project | Doc],
) -> None:
    owner = seed["owner"]
    doc = seed["doc"]
    assert isinstance(owner, User)
    assert isinstance(doc, Doc)
    doc.content = "Intro\nThe final claim needs evidence.\n"
    db.commit()
    ctx = AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=owner.id,
        token_scope="write",
        active_project_id="project-a",
    )

    result = AgentCommandExecutor().execute(
        db,
        ctx,
        "propose_doc_edit",
        {
            "doc_id": "doc-a",
            "original_text": "final claim",
            "range_start": 0,
            "range_end": 5,
            "new_text": "central claim",
            "reason": "precision",
        },
    )

    annotation = db.get(Annotation, result.payload["proposal_id"])
    expected_start = doc.content.index("final claim")
    assert annotation is not None
    assert annotation.range_from == expected_start
    assert annotation.range_to == expected_start + len("final claim")
    assert annotation.original == "final claim"
    assert result.payload["range_start"] == annotation.range_from
    assert result.payload["range_end"] == annotation.range_to
    assert result.payload["anchor_status"] == "recovered"
    assert result.payload["anchor_reason"] == "unique_exact_match"


def test_create_suggestion_relocates_nearest_duplicate_original_text(
    db: Session,
    seed: dict[str, User | Project | Doc],
) -> None:
    owner = seed["owner"]
    doc = seed["doc"]
    assert isinstance(owner, User)
    assert isinstance(doc, Doc)
    doc.content = "First repeated phrase.\nSecond repeated phrase.\n"
    db.commit()
    second = doc.content.rindex("repeated phrase")
    ctx = AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=owner.id,
        token_scope="write",
        active_project_id="project-a",
    )

    result = AgentCommandExecutor().execute(
        db,
        ctx,
        "create_suggestion",
        {
            "doc_id": "doc-a",
            "original_text": "repeated phrase",
            "range_start": second + 1,
            "range_end": second + 16,
            "content": "Clarify the second occurrence.",
            "proposed_text": "specific repeated phrase",
        },
    )

    annotation = db.get(Annotation, result.payload["suggestion_id"])
    assert annotation is not None
    assert annotation.range_from == second
    assert annotation.range_to == second + len("repeated phrase")
    assert result.payload["range_start"] == second
    assert result.payload["anchor_status"] == "recovered"
    assert result.payload["anchor_reason"] == "nearest_exact_match"


def test_create_suggestion_without_range_marks_duplicate_anchor_for_review(
    db: Session,
    seed: dict[str, User | Project | Doc],
) -> None:
    owner = seed["owner"]
    doc = seed["doc"]
    assert isinstance(owner, User)
    assert isinstance(doc, Doc)
    doc.content = "First repeated phrase.\nSecond repeated phrase.\n"
    db.commit()
    ctx = AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=owner.id,
        token_scope="write",
        active_project_id="project-a",
    )

    result = AgentCommandExecutor().execute(
        db,
        ctx,
        "create_suggestion",
        {
            "doc_id": "doc-a",
            "original_text": "repeated phrase",
            "content": "Clarify which occurrence should change.",
            "proposed_text": "specific phrase",
        },
    )

    annotation = db.get(Annotation, result.payload["suggestion_id"])
    assert annotation is not None
    assert annotation.range_from == 0
    assert annotation.range_to == 0
    assert result.payload["anchor_status"] == "needs_review"
    assert result.payload["anchor_reason"] == "ambiguous_exact_matches"


def test_write_scope_creates_nested_text_file(db: Session, seed: dict[str, User | Project | Doc]) -> None:
    owner = seed["owner"]
    assert isinstance(owner, User)
    ctx = AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=owner.id,
        token_scope="write",
        active_project_id="project-a",
    )

    result = AgentCommandExecutor().execute(
        db,
        ctx,
        "project_create_text_file",
        {"path": "notes/review.md", "content": "# Review\n"},
    )

    doc = db.get(Doc, result.payload["doc_id"])
    assert result.payload["status"] == "created"
    assert result.payload["path"] == "notes/review.md"
    assert doc is not None
    assert doc.format == "md"

"""Read-only Agent command behavior for project/document data."""

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
from app.models import Doc, Project, ProjectMember, User


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
    viewer = User(id="viewer", email="viewer@example.com", password_hash="hash", display_name="Viewer")
    project = Project(id="project-a", user_id=owner.id, name="Paper", project_type="paper")
    member = ProjectMember(project_id=project.id, user_id=viewer.id, role="viewer")
    doc = Doc(
        id="doc-a",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content="\\section{Intro}\nHello\n\\section{Method}\nWorld",
    )
    db.add_all([owner, viewer, project, member, doc])
    db.commit()
    return {"owner": owner, "viewer": viewer, "project": project, "doc": doc}


def test_project_read_commands_select_and_read_doc(
    db: Session,
    seed: dict[str, User | Project | Doc],
) -> None:
    viewer = seed["viewer"]
    assert isinstance(viewer, User)
    ctx = AgentCommandContext(source=AgentCommandSource.MCP, user_id=viewer.id)
    executor = AgentCommandExecutor()

    selected = executor.execute(db, ctx, "superleaf_select_project", {"project_id": "project-a"})
    assert selected.next_context.active_project_id == "project-a"

    docs = executor.execute(db, selected.next_context, "project_list_docs", {})
    assert docs.payload["docs"][0]["name"] == "main.tex"

    content = executor.execute(db, selected.next_context, "project_read_doc", {"doc_id": "doc-a"})
    assert content.payload["content"].startswith("\\section{Intro}")


def test_list_projects_can_filter_by_project_type(
    db: Session,
    seed: dict[str, User | Project | Doc],
) -> None:
    owner = seed["owner"]
    assert isinstance(owner, User)
    db.add(Project(id="skill-project", user_id=owner.id, name="Skill", project_type="skill"))
    db.commit()
    ctx = AgentCommandContext(source=AgentCommandSource.MCP, user_id=owner.id)
    executor = AgentCommandExecutor()

    result = executor.execute(db, ctx, "superleaf_list_projects", {"project_type": "skill"})

    assert [project["id"] for project in result.payload["projects"]] == ["skill-project"]


def test_project_grep_rejects_expensive_regex(db: Session, seed: dict[str, User | Project | Doc]) -> None:
    owner = seed["owner"]
    assert isinstance(owner, User)
    ctx = AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=owner.id,
        active_project_id="project-a",
    )
    executor = AgentCommandExecutor()

    with pytest.raises(HTTPException) as exc:
        executor.execute(db, ctx, "project_grep", {"pattern": "(a+)+"})

    assert "catastrophic" in str(exc.value.detail).lower()


def test_project_grep_and_outline_return_context(db: Session, seed: dict[str, User | Project | Doc]) -> None:
    owner = seed["owner"]
    assert isinstance(owner, User)
    ctx = AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id=owner.id,
        active_project_id="project-a",
    )
    executor = AgentCommandExecutor()

    grep = executor.execute(db, ctx, "project_grep", {"pattern": "section"})
    assert len(grep.payload["hits"]) == 2
    assert grep.payload["hits"][0]["doc_name"] == "main.tex"

    outline = executor.execute(db, ctx, "project_outline", {"doc_id": "doc-a"})
    assert [section["title"] for section in outline.payload["sections"]] == ["Intro", "Method"]

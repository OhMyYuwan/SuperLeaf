"""JSON-RPC transport behavior for backend-native SuperLeaf MCP."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import Doc, Project, ProjectMember, User
from app.services.mcp_token_service import McpTokenService
from app.services.superleaf_mcp_tools import SuperleafMcpToolContext
from app.services.superleaf_mcp_transport import (
    SuperleafMcpSessionStore,
    handle_superleaf_mcp_rpc,
)


@dataclass(slots=True)
class SeedData:
    owner: User
    viewer: User
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
    viewer = User(id="viewer", email="viewer@example.com", password_hash="hash", display_name="Viewer")
    project = Project(id="project-a", user_id=owner.id, name="Project A", project_type="paper")
    viewer_member = ProjectMember(project_id=project.id, user_id=viewer.id, role="viewer")
    doc = Doc(
        id="doc-a",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content="\\section{Intro}\nHello world",
    )
    db.add_all([owner, viewer, project, viewer_member, doc])
    db.commit()
    return SeedData(owner=owner, viewer=viewer, project=project, doc=doc)


@pytest.fixture()
def store() -> SuperleafMcpSessionStore:
    return SuperleafMcpSessionStore(ttl_seconds=3600)


def _ctx(db: Session, user: User, *, scope: str = "read") -> SuperleafMcpToolContext:
    row, _plaintext = McpTokenService(db).create_token(
        user_id=user.id,
        name="test",
        scope=scope,
        expires_in_days=1,
    )
    return SuperleafMcpToolContext(user=user, token=row)


def _request(method: str, params: dict | None = None, *, request_id: int | str = 1) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params or {},
    }


def _initialize(
    db: Session,
    ctx: SuperleafMcpToolContext,
    store: SuperleafMcpSessionStore,
) -> str:
    result = handle_superleaf_mcp_rpc(
        db,
        ctx,
        _request("initialize", {"protocolVersion": "2024-11-05"}),
        session_id="",
        store=store,
    )
    assert result.status_code == 200
    assert result.session_id.startswith("mcp_")
    assert result.body["result"]["serverInfo"]["name"] == "SuperLeaf"
    return result.session_id


def test_initialize_returns_result_and_session_id(
    db: Session,
    seed: SeedData,
    store: SuperleafMcpSessionStore,
) -> None:
    sid = _initialize(db, _ctx(db, seed.owner), store)

    assert sid.startswith("mcp_")
    assert len(sid) == len("mcp_") + 24


def test_non_initialize_requires_existing_session(
    db: Session,
    seed: SeedData,
    store: SuperleafMcpSessionStore,
) -> None:
    missing = handle_superleaf_mcp_rpc(
        db,
        _ctx(db, seed.owner),
        _request("tools/list"),
        session_id="",
        store=store,
    )
    assert missing.status_code == 400
    assert missing.body["error"]["code"] == -32001

    unknown = handle_superleaf_mcp_rpc(
        db,
        _ctx(db, seed.owner),
        _request("tools/list"),
        session_id="mcp_000000000000000000000000",
        store=store,
    )
    assert unknown.status_code == 404
    assert unknown.body["error"]["code"] == -32002


def test_tools_list_returns_registry_tools(
    db: Session,
    seed: SeedData,
    store: SuperleafMcpSessionStore,
) -> None:
    ctx = _ctx(db, seed.owner)
    sid = _initialize(db, ctx, store)

    result = handle_superleaf_mcp_rpc(db, ctx, _request("tools/list"), session_id=sid, store=store)
    assert result.status_code == 200
    names = {tool["name"] for tool in result.body["result"]["tools"]}
    assert {"superleaf_list_projects", "project_read_doc", "project_grep"} <= names


def test_tools_call_persists_active_project_in_session(
    db: Session,
    seed: SeedData,
    store: SuperleafMcpSessionStore,
) -> None:
    ctx = _ctx(db, seed.owner)
    sid = _initialize(db, ctx, store)

    selected = handle_superleaf_mcp_rpc(
        db,
        ctx,
        _request("tools/call", {"name": "superleaf_select_project", "arguments": {"project_id": seed.project.id}}),
        session_id=sid,
        store=store,
    )
    assert selected.status_code == 200
    assert selected.body["result"]["isError"] is False

    listed = handle_superleaf_mcp_rpc(
        db,
        ctx,
        _request("tools/call", {"name": "project_list_docs", "arguments": {}}),
        session_id=sid,
        store=store,
    )
    body = json.loads(listed.body["result"]["content"][0]["text"])
    assert [doc["name"] for doc in body["docs"]] == ["main.tex"]


def test_tool_execution_errors_are_mcp_tool_errors(
    db: Session,
    seed: SeedData,
    store: SuperleafMcpSessionStore,
) -> None:
    ctx = _ctx(db, seed.owner)
    sid = _initialize(db, ctx, store)

    result = handle_superleaf_mcp_rpc(
        db,
        ctx,
        _request("tools/call", {"name": "not_a_tool", "arguments": {}}),
        session_id=sid,
        store=store,
    )
    assert result.status_code == 200
    assert result.body["result"]["isError"] is True
    assert "Unknown SuperLeaf MCP tool" in result.body["result"]["content"][0]["text"]


def test_resources_and_prompts_are_exposed(
    db: Session,
    seed: SeedData,
    store: SuperleafMcpSessionStore,
) -> None:
    ctx = _ctx(db, seed.owner)
    sid = _initialize(db, ctx, store)

    resources = handle_superleaf_mcp_rpc(db, ctx, _request("resources/list"), session_id=sid, store=store)
    assert "superleaf://tool-kernel/instructions" in {
        item["uri"] for item in resources.body["result"]["resources"]
    }

    read = handle_superleaf_mcp_rpc(
        db,
        ctx,
        _request("resources/read", {"uri": "superleaf://tool-kernel/instructions"}),
        session_id=sid,
        store=store,
    )
    assert "SuperLeaf MCP tools" in read.body["result"]["contents"][0]["text"]

    prompts = handle_superleaf_mcp_rpc(db, ctx, _request("prompts/list"), session_id=sid, store=store)
    assert "superleaf_project_review" in {item["name"] for item in prompts.body["result"]["prompts"]}

    prompt = handle_superleaf_mcp_rpc(
        db,
        ctx,
        _request("prompts/get", {"name": "superleaf_project_review", "arguments": {"task": "review intro"}}),
        session_id=sid,
        store=store,
    )
    assert "review intro" in prompt.body["result"]["messages"][0]["content"]["text"]

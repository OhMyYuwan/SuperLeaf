"""Backend MCP protocol delegates to Agent commands."""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.agent_commands.context import AgentCommandContext, AgentCommandSource
from app.database import Base
from app.mcp.sessions import McpSessionStore
from app.mcp.transport import MCP_PROTOCOL_VERSION, handle_mcp_request
from app.models import Doc, Project, User


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
        content="Hello",
    )
    db.add_all([owner, project, doc])
    db.commit()
    return {"owner": owner, "project": project, "doc": doc}


def _rpc(method: str, params: dict | None = None, *, request_id: int | str = 1) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}


def test_mcp_initialize_creates_session(db: Session, seed: dict[str, User | Project | Doc]) -> None:
    owner = seed["owner"]
    assert isinstance(owner, User)
    store = McpSessionStore(ttl_seconds=3600)
    ctx = AgentCommandContext(source=AgentCommandSource.MCP, user_id=owner.id, token_id="token-a")

    result = handle_mcp_request(db, ctx, _rpc("initialize"), session_id="", store=store)

    assert result.status_code == 200
    assert result.session_id.startswith("mcp_")
    assert result.body["result"]["protocolVersion"] == MCP_PROTOCOL_VERSION


def test_mcp_tools_call_persists_active_project(db: Session, seed: dict[str, User | Project | Doc]) -> None:
    owner = seed["owner"]
    assert isinstance(owner, User)
    store = McpSessionStore(ttl_seconds=3600)
    ctx = AgentCommandContext(source=AgentCommandSource.MCP, user_id=owner.id, token_id="token-a")
    initialized = handle_mcp_request(db, ctx, _rpc("initialize"), session_id="", store=store)
    sid = initialized.session_id

    selected = handle_mcp_request(
        db,
        ctx,
        _rpc("tools/call", {"name": "superleaf_select_project", "arguments": {"project_id": "project-a"}}),
        session_id=sid,
        store=store,
    )
    assert selected.body["result"]["isError"] is False

    listed = handle_mcp_request(
        db,
        ctx,
        _rpc("tools/call", {"name": "project_list_docs", "arguments": {}}),
        session_id=sid,
        store=store,
    )
    payload = json.loads(listed.body["result"]["content"][0]["text"])
    assert [doc["name"] for doc in payload["docs"]] == ["main.tex"]


def test_mcp_tool_unexpected_exceptions_are_tool_errors(
    db: Session,
    seed: dict[str, User | Project | Doc],
) -> None:
    class BoomExecutor:
        def execute(self, *_args, **_kwargs):
            raise RuntimeError("boom")

    owner = seed["owner"]
    assert isinstance(owner, User)
    store = McpSessionStore(ttl_seconds=3600)
    ctx = AgentCommandContext(source=AgentCommandSource.MCP, user_id=owner.id, token_id="token-a")
    sid = handle_mcp_request(db, ctx, _rpc("initialize"), session_id="", store=store).session_id

    result = handle_mcp_request(
        db,
        ctx,
        _rpc("tools/call", {"name": "project_list_docs", "arguments": {}}),
        session_id=sid,
        store=store,
        executor=BoomExecutor(),
    )

    assert result.status_code == 200
    assert result.body["result"]["isError"] is True
    assert "boom" in result.body["result"]["content"][0]["text"]


def test_mcp_session_store_prunes_to_max_sessions() -> None:
    store = McpSessionStore(ttl_seconds=3600, max_sessions=2)

    first = store.create()
    second = store.create()
    third = store.create()

    assert store.get(first.id) is None
    assert store.get(second.id) is not None
    assert store.get(third.id) is not None
    assert store.status()["session_count"] == 2

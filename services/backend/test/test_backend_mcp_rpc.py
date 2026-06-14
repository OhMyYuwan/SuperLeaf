"""HTTP route tests for the backend-native SuperLeaf MCP endpoint."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import mcp_rpc
from app.database import Base, get_session
from app.models import Doc, Project, User
from app.services.mcp_token_service import McpTokenService
from app.services.superleaf_mcp_transport import MCP_PROTOCOL_VERSION


@dataclass(slots=True)
class SeedData:
    owner: User
    project: Project
    doc: Doc
    token: str


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
        content="\\section{Intro}\nHello world",
    )
    db.add_all([owner, project, doc])
    db.commit()
    _row, token = McpTokenService(db).create_token(
        user_id=owner.id,
        name="codex",
        scope="read",
        expires_in_days=1,
    )
    return SeedData(owner=owner, project=project, doc=doc, token=token)


@pytest.fixture()
def client(db: Session) -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(mcp_rpc.router)

    def override_session() -> Iterator[Session]:
        yield db

    app.dependency_overrides[get_session] = override_session
    with TestClient(app) as test_client:
        yield test_client


def _rpc(method: str, params: dict | None = None, *, request_id: int = 1) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params or {},
    }


def _headers(token: str, session_id: str = "") -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json,text/event-stream",
        "Content-Type": "application/json",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    return headers


def _initialize(client: TestClient, token: str) -> str:
    resp = client.post(
        "/mcp",
        json=_rpc("initialize", {"protocolVersion": MCP_PROTOCOL_VERSION}),
        headers=_headers(token),
    )
    assert resp.status_code == 200, resp.text
    sid = resp.headers["mcp-session-id"]
    assert sid.startswith("mcp_")
    body = resp.json()
    assert resp.headers["mcp-protocol-version"] == MCP_PROTOCOL_VERSION
    assert body["result"]["protocolVersion"] == MCP_PROTOCOL_VERSION
    assert body["result"]["serverInfo"]["name"] == "SuperLeaf"
    return sid


def test_mcp_initialize_requires_bearer_token(client: TestClient) -> None:
    resp = client.post("/mcp", json=_rpc("initialize"))
    assert resp.status_code == 401


def test_mcp_initialize_returns_session_header(
    client: TestClient,
    seed: SeedData,
) -> None:
    sid = _initialize(client, seed.token)
    assert len(sid) == len("mcp_") + 24


def test_mcp_tools_list_with_session(
    client: TestClient,
    seed: SeedData,
) -> None:
    sid = _initialize(client, seed.token)
    resp = client.post("/mcp", json=_rpc("tools/list"), headers=_headers(seed.token, sid))
    assert resp.status_code == 200, resp.text
    assert resp.headers["mcp-session-id"] == sid
    names = {tool["name"] for tool in resp.json()["result"]["tools"]}
    assert "project_read_doc" in names


def test_mcp_tools_call_can_access_backend_project_data(
    client: TestClient,
    seed: SeedData,
) -> None:
    sid = _initialize(client, seed.token)
    resp = client.post(
        "/mcp",
        json=_rpc("tools/call", {"name": "superleaf_list_projects", "arguments": {}}),
        headers=_headers(seed.token, sid),
    )
    assert resp.status_code == 200, resp.text
    tool_body = json.loads(resp.json()["result"]["content"][0]["text"])
    assert [project["id"] for project in tool_body["projects"]] == [seed.project.id]


def test_mcp_post_supports_json_rpc_batch(
    client: TestClient,
    seed: SeedData,
) -> None:
    sid = _initialize(client, seed.token)

    resp = client.post(
        "/mcp",
        json=[_rpc("tools/list", request_id=1), _rpc("resources/list", request_id=2)],
        headers=_headers(seed.token, sid),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body, list)
    assert [item["id"] for item in body] == [1, 2]
    assert "tools" in body[0]["result"]
    assert "resources" in body[1]["result"]


def test_mcp_current_context_resource_reflects_session_project(
    client: TestClient,
    seed: SeedData,
) -> None:
    sid = _initialize(client, seed.token)
    selected = client.post(
        "/mcp",
        json=_rpc(
            "tools/call",
            {"name": "superleaf_select_project", "arguments": {"project_id": seed.project.id}},
        ),
        headers=_headers(seed.token, sid),
    )
    assert selected.status_code == 200, selected.text

    resp = client.post(
        "/mcp",
        json=_rpc("resources/read", {"uri": "superleaf://context/current"}),
        headers=_headers(seed.token, sid),
    )

    assert resp.status_code == 200, resp.text
    text = resp.json()["result"]["contents"][0]["text"]
    payload = json.loads(text)
    assert payload["status"] == "ok"
    assert payload["context"]["active_project_id"] == seed.project.id
    assert payload["context"]["source"] == "mcp"


def test_mcp_status_reports_backend_native_service(
    client: TestClient,
    seed: SeedData,
) -> None:
    sid = _initialize(client, seed.token)

    resp = client.get("/mcp/status", headers=_headers(seed.token, sid))

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "superleaf-backend-native-mcp"
    assert body["mcp_url"] == "/mcp"
    assert body["sessions"]["session_count"] >= 1


def test_mcp_get_sse_requires_session_and_streams_ready_event(
    client: TestClient,
    seed: SeedData,
) -> None:
    sid = _initialize(client, seed.token)

    missing_accept = client.get(
        "/mcp",
        headers={
            "Authorization": f"Bearer {seed.token}",
            "Mcp-Session-Id": sid,
        },
    )
    assert missing_accept.status_code == 406

    resp = client.get(
        "/mcp",
        headers={**_headers(seed.token, sid), "Accept": "text/event-stream"},
    )

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert "event: message" in resp.text
    assert "notifications/superleaf/stream_ready" in resp.text
    assert "id: " in resp.text


def test_mcp_get_sse_rejects_invalid_last_event_id(
    client: TestClient,
    seed: SeedData,
) -> None:
    sid = _initialize(client, seed.token)

    resp = client.get(
        "/mcp",
        headers={
            **_headers(seed.token, sid),
            "Accept": "text/event-stream",
            "Last-Event-ID": "not_for_this_session",
        },
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == -32000


def test_mcp_delete_closes_session(
    client: TestClient,
    seed: SeedData,
) -> None:
    sid = _initialize(client, seed.token)

    deleted = client.delete("/mcp", headers=_headers(seed.token, sid))
    assert deleted.status_code == 204

    resp = client.post("/mcp", json=_rpc("tools/list"), headers=_headers(seed.token, sid))
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == -32002

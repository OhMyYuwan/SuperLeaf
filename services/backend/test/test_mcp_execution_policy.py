import json
import socket
from datetime import datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import SESSION_COOKIE_NAME
from app.api.native_agents import router as native_agents_router
from app.database import Base
from app.database import get_session as get_db_session
from app.models import NativeMcpServer, Session, User
from app.services import mcp_policy, mcp_tool_service
from app.services.mcp_config_service import McpConfigService
from app.services.mcp_tool_service import discover_mcp_tools
from app.settings import settings


def _db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        future=True,
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return session_factory()


def _client(db):
    app = FastAPI()

    def override_session():
        yield db

    app.dependency_overrides[get_db_session] = override_session
    app.include_router(native_agents_router)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "session-user")
    return client


def _user(db, *, user_id: str = "user", is_admin: bool = False) -> User:
    user = User(id=user_id, email=f"{user_id}@example.com", password_hash="hash", is_admin=is_admin)
    db.add(user)
    db.add(
        Session(
            id=f"session-{user_id}",
            user_id=user.id,
            expires_at=datetime.utcnow() + timedelta(hours=1),
        )
    )
    db.commit()
    return user


def _policy_defaults(monkeypatch):
    monkeypatch.setattr(settings, "mcp_remote_enabled", True)
    monkeypatch.setattr(settings, "mcp_stdio_enabled", False)
    monkeypatch.setattr(settings, "mcp_inline_config_enabled", False)
    monkeypatch.setattr(settings, "mcp_remote_private_networks_enabled", False)


def test_mcp_policy_endpoint_returns_public_defaults(monkeypatch):
    _policy_defaults(monkeypatch)
    db = _db()
    _user(db)
    client = _client(db)

    response = client.get("/api/native-agent/mcp/policy")

    assert response.status_code == 200
    assert response.json() == {
        "remote_enabled": True,
        "stdio_enabled": False,
        "inline_config_enabled": False,
        "remote_private_networks_enabled": False,
        "allowed_transports": ["remote"],
    }


def test_custom_stdio_mcp_can_be_saved_but_not_probed(monkeypatch):
    _policy_defaults(monkeypatch)
    db = _db()
    _user(db)
    client = _client(db)

    create_response = client.post(
        "/api/native-agent/mcp/servers",
        json={
            "source": "custom",
            "name": "local@danger",
            "transport": "stdio",
            "command": "python",
            "args": ["-c", "print('would execute')"],
        },
    )

    assert create_response.status_code == 201
    server_id = create_response.json()["id"]
    assert create_response.json()["transport"] == "stdio"

    probe_response = client.post(f"/api/native-agent/mcp/servers/{server_id}/probe")

    assert probe_response.status_code == 403
    assert "stdio MCP execution is disabled" in probe_response.text


def test_inline_stdio_probe_is_blocked_by_public_default(monkeypatch):
    _policy_defaults(monkeypatch)
    db = _db()
    _user(db)
    client = _client(db)

    response = client.post(
        "/api/native-agent/mcp/probe",
        json={
            "server": {
                "id": "inline",
                "name": "inline",
                "transport": "stdio",
                "command": "python",
                "args": ["-c", "print('would execute')"],
            }
        },
    )

    assert response.status_code == 403
    assert "stdio MCP execution is disabled" in response.text


def test_remote_mcp_endpoint_rejects_localhost_by_default(monkeypatch):
    _policy_defaults(monkeypatch)
    db = _db()
    _user(db)
    client = _client(db)

    response = client.post(
        "/api/native-agent/mcp/servers",
        json={
            "source": "custom",
            "name": "remote@loopback",
            "transport": "remote",
            "endpoint": "http://127.0.0.1:9000/mcp",
        },
    )

    assert response.status_code == 400
    assert "localhost" in response.text or "private or reserved networks" in response.text


@pytest.mark.asyncio
async def test_remote_mcp_endpoint_lists_tools(monkeypatch):
    _policy_defaults(monkeypatch)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        mcp_policy.socket,
        "getaddrinfo",
        lambda host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))],
    )

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        method = payload.get("method")
        if method == "initialize":
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "result": {"protocolVersion": "2024-11-05", "capabilities": {}},
                },
            )
        if method == "notifications/initialized":
            return httpx.Response(202)
        if method == "tools/list":
            assert request.headers["authorization"] == "Bearer remote-secret"
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "result": {
                        "tools": [
                            {
                                "name": "search",
                                "description": "Search remote content",
                                "inputSchema": {"type": "object", "properties": {}},
                            }
                        ]
                    },
                },
            )
        return httpx.Response(400, json={"error": "unexpected"})

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        mcp_tool_service.httpx,
        "AsyncClient",
        lambda *args, **kwargs: real_async_client(transport=transport, timeout=kwargs.get("timeout")),
    )

    refs = await discover_mcp_tools(
        {
            "mcp_servers": [
                {
                    "id": "remote",
                    "name": "Remote",
                    "transport": "remote",
                    "endpoint": "https://mcp.example.test/rpc",
                    "env": {"MCP_AUTH_TOKEN": "remote-secret"},
                    "allowed_tools": ["search"],
                }
            ]
        }
    )

    assert [ref.tool_name for ref in refs] == ["search"]


def test_runtime_ignores_inline_servers_and_filters_stdio(monkeypatch):
    _policy_defaults(monkeypatch)
    db = _db()
    user = _user(db)
    remote = NativeMcpServer(
        user_id=user.id,
        source="custom",
        name="remote@ok",
        transport="remote",
        command="https://mcp.example.test/rpc",
        allowed_tools=["search"],
        is_enabled=True,
    )
    local = NativeMcpServer(
        user_id=user.id,
        source="custom",
        name="local@blocked",
        transport="stdio",
        command="python",
        args=["-c", "print('blocked')"],
        is_enabled=True,
    )
    db.add_all([remote, local])
    db.commit()

    runtime = McpConfigService(db).resolve_runtime_config(
        user_id=user.id,
        runtime_config={
            "mcp_servers": [
                {
                    "id": "inline-stdio",
                    "transport": "stdio",
                    "command": "python",
                    "args": ["-c", "print('inline')"],
                }
            ],
            "mcp_server_ids": [remote.id, local.id],
        },
    )

    assert len(runtime["mcp_servers"]) == 1
    assert runtime["mcp_servers"][0]["id"] == remote.id
    assert runtime["mcp_servers"][0]["transport"] == "remote"
    assert runtime["mcp_servers"][0]["endpoint"] == "https://mcp.example.test/rpc"


def test_catalog_execution_fields_are_not_overridden(monkeypatch):
    _policy_defaults(monkeypatch)
    db = _db()
    user = _user(db)
    svc = McpConfigService(db)
    preset = {
        "id": "safe-preset",
        "name": "Safe Preset",
        "description": "Safe",
        "transport": {"type": "stdio", "command": "uvx", "args": ["safe-mcp"]},
        "tool_policy": {"default_allowed_tools": ["safe_tool"]},
    }
    monkeypatch.setattr(svc.catalog, "preset", lambda _preset_id: preset)

    row = svc.ensure_preset_server("safe-preset", user_id=user.id, env={})
    updated = svc.update_server(
        row.id,
        user_id=user.id,
        patch={
            "command": "python",
            "args": ["-c", "print('override')"],
            "allowed_tools": ["safe_tool"],
            "is_enabled": True,
        },
    )

    assert updated is not None
    assert updated.command == "uvx"
    assert updated.args == ["safe-mcp"]
    assert updated.allowed_tools == ["safe_tool"]

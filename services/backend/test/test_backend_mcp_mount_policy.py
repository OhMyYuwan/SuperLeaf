"""Backend MCP route mount policy."""

from __future__ import annotations

from app.main import create_app
from app.settings import settings


def _paths(app) -> set[str]:
    return {route.path for route in app.routes}


def test_mcp_route_is_not_mounted_by_default(monkeypatch) -> None:
    monkeypatch.setattr(settings, "mcp_server_enabled", False)

    app = create_app()

    assert "/mcp" not in _paths(app)


def test_mcp_route_is_mounted_when_enabled(monkeypatch) -> None:
    monkeypatch.setattr(settings, "mcp_server_enabled", True)

    app = create_app()

    assert "/mcp" in _paths(app)

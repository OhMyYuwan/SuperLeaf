from __future__ import annotations

import socket
from unittest.mock import Mock

import httpx
import pytest

from app.services.skill_marketplace_service import (
    MarketplaceEntry,
    SkillMarketplaceError,
    SkillMarketplaceService,
)


def test_skill_marketplace_rejects_absolute_loopback_entry_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog_url = "https://example.com/marketplace.json"
    private_url = "http://127.0.0.1:8765/private/SKILL.md"
    requested: list[str] = []

    def fake_handle_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ANN001
        requested.append(str(request.url))
        raise AssertionError(f"unexpected request: {request.url}")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle_request)

    service = SkillMarketplaceService(Mock(), catalog_url=catalog_url)
    with pytest.raises(SkillMarketplaceError, match="localhost|private|reserved"):
        service._fetch_text(private_url)

    assert requested == []


def test_skill_marketplace_rejects_private_catalog_url_before_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_catalog_url = "http://127.0.0.1:8765/marketplace.json"
    requested: list[str] = []

    def fake_handle_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ANN001
        requested.append(str(request.url))
        raise AssertionError(f"unexpected request: {request.url}")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle_request)

    service = SkillMarketplaceService(Mock(), catalog_url=private_catalog_url)
    with pytest.raises(SkillMarketplaceError, match="localhost|private|reserved"):
        service.list_entries(user_id="user")

    assert requested == []


def test_skill_marketplace_install_rejects_private_catalog_url_before_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_catalog_url = "http://127.0.0.1:8765/marketplace.json"
    requested: list[str] = []

    def fake_handle_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ANN001
        requested.append(str(request.url))
        raise AssertionError(f"unexpected request: {request.url}")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle_request)

    service = SkillMarketplaceService(Mock(), catalog_url=private_catalog_url)
    with pytest.raises(SkillMarketplaceError, match="localhost|private|reserved"):
        service.install("demo", user_id="user")

    assert requested == []


def test_skill_marketplace_rejects_absolute_private_readme_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog_url = "https://example.com/marketplace.json"
    private_url = "http://169.254.169.254/latest/meta-data"
    requested: list[str] = []

    def fake_handle_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ANN001
        requested.append(str(request.url))
        raise AssertionError(f"unexpected request: {request.url}")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle_request)

    service = SkillMarketplaceService(Mock(), catalog_url=catalog_url)
    readme = service._clone_readme(
        _marketplace_entry(readme_url=private_url),
        local_name="Demo Skill",
    )

    assert requested == []
    assert readme.startswith("# Demo Skill")


def test_skill_marketplace_allows_relative_entry_under_catalog_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog_url = "https://example.com/marketplace.json"
    requested: list[tuple[str, str, str]] = []

    def fake_getaddrinfo(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    def fake_handle_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ANN001
        requested.append(
            (
                request.url.host or "",
                request.headers.get("Host", ""),
                request.url.path,
            )
        )
        if request.url.path == "/skills/demo/SKILL.md":
            return httpx.Response(200, text="# Demo skill\n", request=request)
        raise AssertionError(f"unexpected request path: {request.url.path}")

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle_request)

    service = SkillMarketplaceService(Mock(), catalog_url=catalog_url)
    content = service._fetch_text("skills/demo/SKILL.md")

    assert content == "# Demo skill\n"
    assert requested == [("93.184.216.34", "example.com", "/skills/demo/SKILL.md")]


def test_skill_marketplace_fetch_uses_pinned_http_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog_url = "https://example.com/marketplace.json"
    entry_url = "https://example.com/skills/demo/SKILL.md"
    captured: list[tuple[str, str, str]] = []

    def fake_getaddrinfo(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    def fake_handle_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ANN001
        captured.append(
            (
                request.url.host or "",
                request.headers.get("Host", ""),
                request.url.path,
            )
        )
        if request.url.path == "/skills/demo/SKILL.md":
            return httpx.Response(200, text="# Demo skill\n", request=request)
        raise AssertionError(f"unexpected request path: {request.url.path}")

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle_request)

    service = SkillMarketplaceService(Mock(), catalog_url=catalog_url)
    content = service._fetch_text(entry_url)

    assert content == "# Demo skill\n"
    assert captured == [("93.184.216.34", "example.com", "/skills/demo/SKILL.md")]


def _marketplace_entry(**overrides: str) -> MarketplaceEntry:
    values = {
        "id": "demo",
        "name": "demo",
        "display_name": "Demo Skill",
        "version": "1.0.0",
        "author_github": "demo",
        "description": "Demo marketplace skill.",
        "tags": [],
        "license": "MIT",
        "path": "skills/demo",
        "entry": "SKILL.md",
        "skill_url": "skills/demo/skill.yaml",
        "entry_url": "skills/demo/SKILL.md",
        "readme_url": "",
        "checksum_sha256": "",
        "repo_url": "https://github.com/example/skills.git",
        "source_url": "https://github.com/example/skills/tree/main/skills/demo",
        "source_ref": "main",
        "skill_name": "demo",
        "install_command": (
            "npx --yes @codex/skills add https://github.com/example/skills.git "
            "--skill demo --agent codex --copy --yes"
        ),
    }
    values.update(overrides)
    return MarketplaceEntry(**values)

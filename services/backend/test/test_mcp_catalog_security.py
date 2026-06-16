from __future__ import annotations

import json
import socket

import pytest

from app.services import mcp_catalog_service
from app.services.mcp_catalog_service import McpCatalogError, McpCatalogService


def _resolve_public(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any hostname resolve to a public IP.

    The catalog host (``catalog.example.test``) is not a real name; without
    this the SSRF policy now fails closed on the unresolvable host before the
    preset-URL policy under test is ever exercised. Literal-IP preset URLs
    (127.0.0.1, etc.) are still validated directly and never hit DNS.
    """
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_a, **_k: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0)),
        ],
    )


class JsonResponse:
    def __init__(self, payload: dict) -> None:
        self.payload = json.dumps(payload).encode()

    def __enter__(self) -> JsonResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.payload


def test_mcp_catalog_rejects_absolute_loopback_preset_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    _resolve_public(monkeypatch)
    catalog_url = "https://catalog.example.test/catalog.json"
    private_url = "http://127.0.0.1:8765/private/preset.json"
    requested: list[str] = []

    def fake_urlopen(req, *, timeout: int) -> JsonResponse:
        requested.append(req.full_url)
        if req.full_url == catalog_url:
            return JsonResponse({"presets": [private_url]})
        if req.full_url == private_url:
            return JsonResponse({"id": "private"})
        raise AssertionError(f"unexpected URL: {req.full_url}")

    monkeypatch.setattr(mcp_catalog_service.urllib.request, "urlopen", fake_urlopen)

    service = McpCatalogService(root=tmp_path, catalog_url=catalog_url)
    with pytest.raises(McpCatalogError, match="localhost|private|reserved"):
        service._catalog_from_url(catalog_url)

    assert requested == [catalog_url]


def test_mcp_catalog_rejects_absolute_private_golden_test_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    private_url = "http://127.0.0.1:8765/private/golden.json"
    requested: list[str] = []

    def fake_urlopen(req, *, timeout: int) -> JsonResponse:
        requested.append(req.full_url)
        if req.full_url == private_url:
            return JsonResponse({"id": "private-golden"})
        raise AssertionError(f"unexpected URL: {req.full_url}")

    monkeypatch.setattr(mcp_catalog_service.urllib.request, "urlopen", fake_urlopen)

    service = McpCatalogService(root=tmp_path, catalog_url="")
    preset = {
        "id": "demo",
        "_catalog_source": "remote",
        "_catalog_root": "https://catalog.example.test/presets/",
        "verification": {"golden_tests": [private_url]},
    }
    with pytest.raises(McpCatalogError, match="localhost|private|reserved"):
        service._golden_tests_for_preset(preset)

    assert requested == []


def test_mcp_catalog_allows_relative_preset_under_same_origin(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    _resolve_public(monkeypatch)
    catalog_url = "https://catalog.example.test/catalog.json"
    preset_url = "https://catalog.example.test/presets/demo.json"
    requested: list[str] = []

    def fake_urlopen(req, *, timeout: int) -> JsonResponse:
        requested.append(req.full_url)
        if req.full_url == catalog_url:
            return JsonResponse({"presets": ["presets/demo.json"]})
        if req.full_url == preset_url:
            return JsonResponse({"id": "demo", "name": "Demo"})
        raise AssertionError(f"unexpected URL: {req.full_url}")

    monkeypatch.setattr(mcp_catalog_service.urllib.request, "urlopen", fake_urlopen)

    service = McpCatalogService(root=tmp_path, catalog_url=catalog_url)
    catalog = service._catalog_from_url(catalog_url)

    assert catalog["presets"][0]["id"] == "demo"
    assert requested == [catalog_url, preset_url]

from __future__ import annotations

import socket

import httpx
import pytest
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

def test_mcp_catalog_rejects_absolute_loopback_preset_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    _resolve_public(monkeypatch)
    catalog_url = "https://catalog.example.test/catalog.json"
    private_url = "http://127.0.0.1:8765/private/preset.json"
    requested: list[tuple[str, str, str]] = []

    def fake_handle_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ANN001
        requested.append(
            (
                request.url.host or "",
                request.headers.get("Host", ""),
                request.url.path,
            )
        )
        if request.url.path == "/catalog.json":
            return httpx.Response(200, json={"presets": [private_url]}, request=request)
        raise AssertionError(f"unexpected request path: {request.url.path}")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle_request)

    service = McpCatalogService(root=tmp_path, catalog_url=catalog_url)
    with pytest.raises(McpCatalogError, match="localhost|private|reserved"):
        service._catalog_from_url(catalog_url)

    assert requested == [("93.184.216.34", "catalog.example.test", "/catalog.json")]


def test_mcp_catalog_rejects_absolute_private_golden_test_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    private_url = "http://127.0.0.1:8765/private/golden.json"
    requested: list[str] = []

    def fake_handle_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ANN001
        requested.append(str(request.url))
        raise AssertionError(f"unexpected request: {request.url}")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle_request)

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
    requested: list[tuple[str, str, str]] = []

    def fake_handle_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ANN001
        requested.append(
            (
                request.url.host or "",
                request.headers.get("Host", ""),
                request.url.path,
            )
        )
        if request.url.path == "/catalog.json":
            return httpx.Response(200, json={"presets": ["presets/demo.json"]}, request=request)
        if request.url.path == "/presets/demo.json":
            return httpx.Response(200, json={"id": "demo", "name": "Demo"}, request=request)
        raise AssertionError(f"unexpected request path: {request.url.path}")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle_request)

    service = McpCatalogService(root=tmp_path, catalog_url=catalog_url)
    catalog = service._catalog_from_url(catalog_url)

    assert catalog["presets"][0]["id"] == "demo"
    assert requested == [
        ("93.184.216.34", "catalog.example.test", "/catalog.json"),
        ("93.184.216.34", "catalog.example.test", "/presets/demo.json"),
    ]


def test_mcp_catalog_remote_fetch_uses_pinned_http_transport(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    _resolve_public(monkeypatch)
    catalog_url = "https://catalog.example.test/catalog.json"
    captured: list[tuple[str, str, str]] = []

    def fake_handle_request(self, request: httpx.Request) -> httpx.Response:  # noqa: ANN001
        captured.append(
            (
                request.url.host or "",
                request.headers.get("Host", ""),
                request.url.path,
            )
        )
        if request.headers.get("Host") != "catalog.example.test":
            raise AssertionError(f"missing original Host header: {request.headers!r}")
        if request.url.path == "/catalog.json":
            return httpx.Response(200, json={"presets": ["presets/demo.json"]}, request=request)
        if request.url.path == "/presets/demo.json":
            return httpx.Response(200, json={"id": "demo", "name": "Demo"}, request=request)
        raise AssertionError(f"unexpected request path: {request.url.path}")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_handle_request)

    service = McpCatalogService(root=tmp_path, catalog_url=catalog_url)
    catalog = service._catalog_from_url(catalog_url)

    assert catalog["presets"][0]["id"] == "demo"
    assert captured == [
        ("93.184.216.34", "catalog.example.test", "/catalog.json"),
        ("93.184.216.34", "catalog.example.test", "/presets/demo.json"),
    ]

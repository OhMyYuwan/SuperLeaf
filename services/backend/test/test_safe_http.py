"""Unit tests for the SSRF-safe HTTP egress layer (safe_http).

These exercise the DNS-rebinding fix: resolve once, validate every returned
address, pin the connection to the validated IP. No real network is touched —
``socket.getaddrinfo`` is monkeypatched and the parent transport's
``handle_async_request`` is intercepted to capture the rewritten request.
"""

from __future__ import annotations

import ipaddress
import socket

import httpx
import pytest

from app.services import safe_http
from app.services.safe_http import (
    PinnedAsyncTransport,
    SsrfPolicyError,
    validate_resolved_ip,
)


def _addrinfo(*addrs: tuple[int, str]):
    """Build a getaddrinfo-shaped result list from (family, address) pairs."""
    return [
        (family, socket.SOCK_STREAM, 6, "", (addr, 0))
        for family, addr in addrs
    ]


# --------------------------------------------------------------- policy unit


@pytest.mark.parametrize(
    "addr",
    ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
)
def test_validate_resolved_ip_allows_public(addr: str) -> None:
    validate_resolved_ip(ipaddress.ip_address(addr))  # no raise


@pytest.mark.parametrize(
    "addr",
    [
        "127.0.0.1",
        "10.0.0.7",
        "169.254.169.254",
        "192.168.1.1",
        "::1",
        "fd00::1",
    ],
)
def test_validate_resolved_ip_blocks_private(addr: str) -> None:
    with pytest.raises(SsrfPolicyError):
        validate_resolved_ip(ipaddress.ip_address(addr))


def test_validate_resolved_ip_unwraps_ipv4_mapped_ipv6() -> None:
    # ::ffff:169.254.169.254 must be judged by its embedded IPv4, regardless of
    # the interpreter's ipaddress patch level.
    with pytest.raises(SsrfPolicyError):
        validate_resolved_ip(ipaddress.ip_address("::ffff:169.254.169.254"))


def test_validate_resolved_ip_allow_private_escape_hatch() -> None:
    validate_resolved_ip(
        ipaddress.ip_address("10.0.0.7"), allow_private=True
    )  # no raise


# --------------------------------------------------------- transport rewrite


class _CapturingTransport(PinnedAsyncTransport):
    """Capture the request that reaches the parent transport instead of
    actually connecting."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.captured: httpx.Request | None = None

    async def _real_super(self, request):  # pragma: no cover - helper
        ...


@pytest.fixture()
def capture(monkeypatch: pytest.MonkeyPatch):
    """Patch the grandparent handle_async_request to capture, not connect."""
    captured: dict[str, httpx.Request] = {}

    async def fake_super(self, request):  # noqa: ANN001
        captured["request"] = request
        return httpx.Response(200, text="ok")

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", fake_super
    )
    return captured


async def _send(transport: PinnedAsyncTransport, url: str) -> httpx.Response:
    request = httpx.Request("GET", url)
    return await transport.handle_async_request(request)


@pytest.mark.asyncio
async def test_hostname_public_ip_pins_and_preserves_host(
    capture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: _addrinfo((socket.AF_INET, "93.184.216.34")),
    )
    transport = PinnedAsyncTransport()
    resp = await _send(transport, "https://provider.example.test/v1/info")
    assert resp.status_code == 200

    req = capture["request"]
    # URL host rewritten to the pinned IP literal
    assert req.url.host == "93.184.216.34"
    # Host header preserved as the original hostname
    assert req.headers["Host"] == "provider.example.test"
    # TLS SNI extension carries the original hostname
    assert req.extensions["sni_hostname"] == "provider.example.test"


@pytest.mark.asyncio
async def test_hostname_private_ip_blocked(
    capture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: _addrinfo((socket.AF_INET, "169.254.169.254")),
    )
    transport = PinnedAsyncTransport()
    with pytest.raises(SsrfPolicyError, match="private or reserved"):
        await _send(transport, "https://rebind.attacker.test/mcp")
    assert "request" not in capture  # never reached the connection


@pytest.mark.asyncio
async def test_mixed_public_and_private_resolution_blocked(
    capture, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A domain answering both public and private is a classic rebinding setup.
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: _addrinfo(
            (socket.AF_INET, "93.184.216.34"),
            (socket.AF_INET, "10.0.0.7"),
        ),
    )
    transport = PinnedAsyncTransport()
    with pytest.raises(SsrfPolicyError):
        await _send(transport, "https://provider.example.test/v1")
    assert "request" not in capture


@pytest.mark.asyncio
async def test_dns_failure_is_fail_closed(
    capture, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_a, **_k):
        raise socket.gaierror("no such host")

    monkeypatch.setattr(socket, "getaddrinfo", boom)
    transport = PinnedAsyncTransport()
    with pytest.raises(SsrfPolicyError, match="DNS resolution failed"):
        await _send(transport, "https://nxdomain.attacker.test/mcp")
    assert "request" not in capture


@pytest.mark.asyncio
async def test_literal_private_ip_blocked_without_resolution(
    capture, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A literal IP must be validated directly and must not hit getaddrinfo.
    def boom(*_a, **_k):  # pragma: no cover - must not be called
        raise AssertionError("getaddrinfo should not be called for IP literals")

    monkeypatch.setattr(socket, "getaddrinfo", boom)
    transport = PinnedAsyncTransport()
    with pytest.raises(SsrfPolicyError):
        await _send(transport, "http://169.254.169.254/latest/meta-data")
    assert "request" not in capture


@pytest.mark.asyncio
async def test_literal_public_ip_passes_through_unrewritten(
    capture, monkeypatch: pytest.MonkeyPatch
) -> None:
    transport = PinnedAsyncTransport()
    resp = await _send(transport, "https://93.184.216.34/health")
    assert resp.status_code == 200
    # Literal public IP: passed through without rewriting.
    assert capture["request"].url.host == "93.184.216.34"


@pytest.mark.asyncio
async def test_allow_private_lets_internal_through(
    capture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: _addrinfo((socket.AF_INET, "10.0.0.7")),
    )
    transport = PinnedAsyncTransport(allow_private=True)
    resp = await _send(transport, "http://internal.service.test/v1")
    assert resp.status_code == 200
    assert capture["request"].url.host == "10.0.0.7"


@pytest.mark.asyncio
async def test_ipv6_pinned_host_is_bracketed(
    capture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: _addrinfo(
            (socket.AF_INET6, "2606:2800:220:1:248:1893:25c8:1946")
        ),
    )
    transport = PinnedAsyncTransport()
    resp = await _send(transport, "https://v6.example.test/info")
    assert resp.status_code == 200
    assert capture["request"].url.host == "2606:2800:220:1:248:1893:25c8:1946"
    assert capture["request"].headers["Host"] == "v6.example.test"

"""SSRF-safe HTTP egress for backend-initiated calls.

The vulnerability this module closes
------------------------------------
``validate_*_endpoint`` historically resolved a hostname via ``getaddrinfo`` at
*check time* to make sure it didn't point at a private/reserved network — but
the actual outbound request was made later by ``httpx.AsyncClient`` using the
*hostname string*, which httpx re-resolves at *connect time*. Two independent
DNS lookups with no IP pinning between them is a textbook DNS-rebinding TOCTOU:
an attacker who controls a low-TTL domain answers public for the validation
lookup and ``169.254.169.254`` (or RFC1918) for the connection lookup, and the
backend dutifully POSTs to the rebound internal target — forwarding any bearer
token or decrypted provider API key on the way.

The fix is to do **one** lookup, validate every returned address, then connect
to the validated IP literal — eliminating the window. ``PinnedAsyncTransport``
does that at the httpx transport layer; ``safe_async_client`` is the factory.

Bonus side-effect: ``gaierror`` is converted to a hard error (fail-closed)
rather than silently allowing the request through, which closes the related
fail-open path in the legacy ``_validate_resolved_host`` policy helpers.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Mapping
from typing import Any

import httpx


class SsrfPolicyError(ValueError):
    """Raised when an outbound endpoint is blocked by SSRF policy."""


def _unwrap(ip: ipaddress._BaseAddress) -> ipaddress._BaseAddress:
    """Unwrap IPv4-mapped IPv6 addresses (``::ffff:169.254.169.254``) so the
    embedded IPv4 is what we evaluate. CPython 3.12.4+/3.11.9+ handle this
    natively, but we don't want this module's correctness to depend on the
    runtime's patch level."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    return ip


def validate_resolved_ip(
    ip: ipaddress._BaseAddress, *, allow_private: bool = False
) -> None:
    """Apply the deployment's outbound IP policy to a single resolved address.

    Raises :class:`SsrfPolicyError` if the address is blocked. ``allow_private``
    is the per-policy escape hatch the legacy code already exposed via
    ``provider_private_networks_enabled`` / ``mcp_remote_private_networks_enabled``.
    """
    if allow_private:
        return
    addr = _unwrap(ip)
    if not addr.is_global:
        raise SsrfPolicyError(
            f"Address {ip} resolves to a private or reserved network"
        )


def _resolve_and_pick(host: str, *, allow_private: bool) -> tuple[str, int]:
    """Resolve ``host`` once and return (pinned_address, address_family).

    Every returned address must pass the policy — a domain that resolves to a
    mix of public and private records is rejected outright (the legacy
    ``_validate_resolved_host`` had the same all-or-nothing posture, and a mixed
    record set is a classic rebinding setup). The first address is then pinned
    for the connection, so we connect to exactly an address we validated from
    this single lookup.

    Raises :class:`SsrfPolicyError` on DNS failure (fail-closed), when a
    returned address is blocked, or when nothing usable came back.
    """
    try:
        results = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SsrfPolicyError(
            f"DNS resolution failed for {host!r}; refusing outbound request"
        ) from exc

    pinned: tuple[str, int] | None = None
    for family, _socktype, _proto, _canon, sockaddr in results:
        addr = sockaddr[0]
        ip = ipaddress.ip_address(addr)
        validate_resolved_ip(ip, allow_private=allow_private)  # raises on block
        if pinned is None:
            pinned = (addr, family)

    if pinned is None:
        raise SsrfPolicyError(f"No DNS results for {host!r}")
    return pinned


def _ip_literal_host(addr: str, family: int) -> str:
    """Format an address for use as a URL host: bare for IPv4, bracketed for IPv6."""
    return f"[{addr}]" if family == socket.AF_INET6 else addr


class PinnedTransport(httpx.HTTPTransport):
    """Synchronous companion to :class:`PinnedAsyncTransport`.

    The synchronous catalog and marketplace loaders used to validate URLs with
    the SSRF policy and then let ``urllib`` perform a fresh hostname lookup for
    the real request. This transport gives sync callers the same single-lookup
    pinning guarantee as async provider clients.
    """

    def __init__(self, *, allow_private: bool = False, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._allow_private = allow_private

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        host = url.host
        if not host:
            return super().handle_request(request)

        try:
            ip = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            ip = None
        if ip is not None:
            validate_resolved_ip(ip, allow_private=self._allow_private)
            return super().handle_request(request)

        pinned_addr, family = _resolve_and_pick(
            host, allow_private=self._allow_private
        )
        pinned_host = _ip_literal_host(pinned_addr, family)

        port = url.port
        default_port = 443 if url.scheme == "https" else 80
        host_header = host if port in (None, default_port) else f"{host}:{port}"

        new_headers = httpx.Headers(request.headers)
        new_headers["Host"] = host_header
        new_extensions = dict(request.extensions or {})
        new_extensions["sni_hostname"] = host

        new_request = httpx.Request(
            method=request.method,
            url=url.copy_with(host=pinned_host),
            headers=new_headers,
            stream=request.stream,
            extensions=new_extensions,
        )
        return super().handle_request(new_request)


class PinnedAsyncTransport(httpx.AsyncHTTPTransport):
    """Resolve once, validate, pin the IP for the connection.

    Per request:
      - if URL host is already an IP literal, validate it directly
      - else ``getaddrinfo`` once, validate every returned address, pick the
        first that passes
      - rewrite the request URL host to that IP literal so httpx connects to
        exactly the IP we validated (no second resolution by httpcore)
      - keep ``Host:`` header pointing at the original hostname (HTTP/1.1
        routing on the remote side stays correct)
      - pass ``sni_hostname`` extension so TLS SNI/cert verification still uses
        the original hostname (httpx 0.28 honours this)
    """

    def __init__(self, *, allow_private: bool = False, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._allow_private = allow_private

    async def handle_async_request(
        self, request: httpx.Request
    ) -> httpx.Response:
        url = request.url
        host = url.host
        if not host:
            return await super().handle_async_request(request)

        # If URL host is already an IP literal, validate then pass through.
        try:
            ip = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            ip = None
        if ip is not None:
            validate_resolved_ip(ip, allow_private=self._allow_private)
            return await super().handle_async_request(request)

        # Hostname path: resolve once, validate, pin.
        pinned_addr, family = _resolve_and_pick(
            host, allow_private=self._allow_private
        )
        pinned_host = _ip_literal_host(pinned_addr, family)

        # Build a port-aware Host header (omit default ports for hygiene).
        port = url.port
        default_port = 443 if url.scheme == "https" else 80
        host_header = host if port in (None, default_port) else f"{host}:{port}"

        # Rewrite URL host to the pinned IP literal so httpx/httpcore connect
        # to that exact address rather than re-resolving the original hostname.
        new_url = url.copy_with(host=pinned_host)

        # Preserve the original Host header so the remote side routes correctly,
        # and tell httpx to use the original hostname for TLS SNI / cert checks.
        new_headers = httpx.Headers(request.headers)
        new_headers["Host"] = host_header
        new_extensions = dict(request.extensions or {})
        new_extensions["sni_hostname"] = host

        new_request = httpx.Request(
            method=request.method,
            url=new_url,
            headers=new_headers,
            stream=request.stream,
            extensions=new_extensions,
        )
        return await super().handle_async_request(new_request)


def safe_async_client(
    *,
    allow_private: bool = False,
    timeout: Any = None,
    trust_env: bool = False,
    **kwargs: Any,
) -> httpx.AsyncClient:
    """Construct an ``httpx.AsyncClient`` whose transport pins resolved IPs.

    Use this anywhere the backend issues HTTP requests to user-controlled or
    user-influenced URLs. ``allow_private`` mirrors the deployment's existing
    ``*_private_networks_enabled`` flag.

    ``trust_env`` defaults to False to match the existing client construction
    in ``dify_client.py`` / ``nanobot_client.py`` (a desktop user's HTTP_PROXY
    pointing at 127.0.0.1 is not supposed to break loopback isolation).
    """
    transport = PinnedAsyncTransport(allow_private=allow_private)
    return httpx.AsyncClient(
        transport=transport, timeout=timeout, trust_env=trust_env, **kwargs
    )


def safe_client(
    *,
    allow_private: bool = False,
    timeout: Any = None,
    trust_env: bool = False,
    **kwargs: Any,
) -> httpx.Client:
    """Construct a synchronous ``httpx.Client`` with pinned-IP egress."""
    transport = PinnedTransport(allow_private=allow_private)
    return httpx.Client(
        transport=transport, timeout=timeout, trust_env=trust_env, **kwargs
    )


def safe_fetch_text(
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    timeout: Any = 20,
    allow_private: bool = False,
    max_bytes: int = 1_048_576,
) -> str:
    """Fetch a small text resource via the synchronous pinned transport."""
    with safe_client(allow_private=allow_private, timeout=timeout) as client:
        with client.stream("GET", url, headers=headers) as response:
            response.raise_for_status()
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise SsrfPolicyError("Outbound response exceeds the configured size limit")
                chunks.append(chunk)
    raw = b"".join(chunks)
    return raw.decode("utf-8", errors="replace")

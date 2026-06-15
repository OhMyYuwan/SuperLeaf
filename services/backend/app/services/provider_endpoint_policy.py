"""Outbound network policy for backend-called provider endpoints.

This is the *registration-time* fast-fail: it rejects an obviously-bad
endpoint when a provider is created or updated, so the user gets an immediate
error instead of a silent failure at request time. The *connection-time*
guarantee — that the IP we validated is the IP we actually connect to — is
enforced separately by :mod:`app.services.safe_http`'s pinned transport, which
every backend HTTP client now uses. Both layers share the same IP policy via
``validate_resolved_ip`` so they cannot drift.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

from ..settings import settings
from .safe_http import SsrfPolicyError, validate_resolved_ip


class ProviderEndpointPolicyError(ValueError):
    """Raised when a provider endpoint is blocked by outbound policy."""


def validate_provider_endpoint(endpoint: str) -> None:
    parsed = urlparse(endpoint.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ProviderEndpointPolicyError("Provider endpoint must be an http(s) URL")
    if parsed.username or parsed.password:
        raise ProviderEndpointPolicyError("Provider endpoint must not include credentials")
    if settings.provider_private_networks_enabled:
        return

    host = (parsed.hostname or "").strip().lower()
    if not host:
        raise ProviderEndpointPolicyError("Provider endpoint must include a host")
    if host == "localhost" or host.endswith(".localhost"):
        raise ProviderEndpointPolicyError(
            "Provider endpoint cannot target localhost by default"
        )

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        _validate_resolved_host(host)
        return
    try:
        validate_resolved_ip(ip)
    except SsrfPolicyError as exc:
        raise ProviderEndpointPolicyError(
            "Provider endpoint cannot target private or reserved networks by default"
        ) from exc


def _validate_resolved_host(host: str) -> None:
    # Fail closed: a hostname that does not resolve at registration time must
    # not be silently accepted (the legacy ``return`` here was an SSRF
    # fail-open — a name that errored at check time could still resolve to an
    # internal address at connect time).
    try:
        results = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ProviderEndpointPolicyError(
            "Provider endpoint could not be resolved; refusing to register it"
        ) from exc
    for item in results:
        address = item[4][0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        try:
            validate_resolved_ip(ip)
        except SsrfPolicyError as exc:
            raise ProviderEndpointPolicyError(
                "Provider endpoint cannot resolve to private or reserved networks by default"
            ) from exc

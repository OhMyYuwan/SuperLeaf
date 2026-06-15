"""Outbound network policy for backend-called provider endpoints."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

from ..settings import settings


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
    if not ip.is_global:
        raise ProviderEndpointPolicyError(
            "Provider endpoint cannot target private or reserved networks by default"
        )


def _validate_resolved_host(host: str) -> None:
    try:
        results = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return
    for item in results:
        address = item[4][0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        if not ip.is_global:
            raise ProviderEndpointPolicyError(
                "Provider endpoint cannot resolve to private or reserved networks by default"
            )

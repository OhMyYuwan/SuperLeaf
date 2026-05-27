"""Execution policy for user-defined MCP servers."""

from __future__ import annotations

import ipaddress
import socket
from typing import Any
from urllib.parse import urlparse

from ..settings import settings

REMOTE_MCP_TRANSPORTS = {"remote", "http", "https", "sse", "streamable-http", "streamable_http"}
STDIO_MCP_TRANSPORTS = {"", "stdio", "local", "local-stdio", "local_stdio"}


class McpExecutionPolicyError(ValueError):
    """Raised when an MCP server is blocked by deployment policy."""


def normalize_mcp_transport(value: str | None) -> str:
    cleaned = (value or "").strip().lower().replace("_", "-")
    if cleaned in REMOTE_MCP_TRANSPORTS:
        return "remote"
    if cleaned in STDIO_MCP_TRANSPORTS:
        return "stdio"
    raise ValueError(f"Unsupported MCP transport: {value}")


def mcp_transport_allowed(transport: str | None) -> bool:
    normalized = normalize_mcp_transport(transport)
    if normalized == "remote":
        return settings.mcp_remote_enabled
    return settings.mcp_stdio_enabled


def ensure_mcp_transport_allowed(transport: str | None) -> None:
    normalized = normalize_mcp_transport(transport)
    if normalized == "remote" and not settings.mcp_remote_enabled:
        raise McpExecutionPolicyError("Remote MCP execution is disabled by backend configuration")
    if normalized == "stdio" and not settings.mcp_stdio_enabled:
        raise McpExecutionPolicyError(
            "stdio MCP execution is disabled. Enable Local Trusted mode with YLW_MCP_STDIO_ENABLED=true."
        )


def runtime_server_allowed(server: dict[str, Any]) -> bool:
    try:
        return mcp_transport_allowed(str(server.get("transport") or "stdio"))
    except ValueError:
        return False


def remote_endpoint_from_server(server: dict[str, Any]) -> str:
    for key in ("endpoint", "url", "base_url", "command"):
        value = str(server.get(key) or "").strip()
        if value:
            return value
    return ""


def validate_remote_endpoint(endpoint: str) -> None:
    parsed = urlparse(endpoint.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Remote MCP endpoint must be an http(s) URL")
    if settings.mcp_remote_private_networks_enabled:
        return
    host = (parsed.hostname or "").strip().lower()
    if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".localhost"):
        raise ValueError("Remote MCP endpoint cannot target localhost by default")
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        _validate_resolved_host(host)
        return
    if not ip.is_global:
        raise ValueError("Remote MCP endpoint cannot target private or reserved networks by default")


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
            raise ValueError("Remote MCP endpoint cannot resolve to private or reserved networks by default")

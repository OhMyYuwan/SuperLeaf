"""Minimal MCP client for Native Agent tools.

The integration is intentionally narrow: start a configured MCP server for a
single list/call operation, speak JSON-RPC over stdio or a remote endpoint,
then tear it down. That keeps MCP optional and avoids adding a resident process
manager to the writing IDE.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from .mcp_policy import (
    ensure_mcp_transport_allowed,
    normalize_mcp_transport,
    remote_endpoint_from_server,
    validate_remote_endpoint,
)

MAX_MCP_RESULT_CHARS = 24_000


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


# Local Agent Host caps each MCP tool at 120s (SL_LOCAL_AGENT_HOST_MCP_TOOL_TIMEOUT_MS).
# Stay above that with headroom for connection + JSON-RPC round-trips so a slow
# tool surfaces as a tool-side timeout instead of an httpx.ReadTimeout that the
# UI renders as a generic "network error".
MCP_TIMEOUT_SECONDS = _env_float("YLW_MCP_TIMEOUT_SECONDS", 150.0)
ALLOWED_COMMANDS = {"uv", "uvx", "npx", "python", "python3"}
MCP_PROTOCOL_VERSION = "2024-11-05"


class McpToolError(RuntimeError):
    pass


@dataclass(slots=True)
class McpServerConfig:
    id: str
    name: str
    command: str
    transport: str = "remote"
    endpoint: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    allowed_tools: list[str] = field(default_factory=list)


@dataclass(slots=True)
class McpToolRef:
    function_name: str
    server: McpServerConfig
    tool_name: str
    definition: dict[str, Any]


def configured_mcp_servers(runtime_config: dict[str, Any] | None) -> list[McpServerConfig]:
    raw_servers = (runtime_config or {}).get("mcp_servers")
    if not isinstance(raw_servers, list):
        return []

    servers: list[McpServerConfig] = []
    for raw in raw_servers:
        if not isinstance(raw, dict) or raw.get("enabled") is False:
            continue
        try:
            transport = normalize_mcp_transport(str(raw.get("transport") or "stdio"))
        except ValueError:
            continue
        endpoint = remote_endpoint_from_server(raw) if transport == "remote" else ""
        command = endpoint if transport == "remote" else str(raw.get("command") or "").strip()
        if not command and not endpoint:
            continue
        ident = _safe_token(str(raw.get("id") or raw.get("name") or command))
        args = [str(item) for item in raw.get("args", []) if str(item).strip()]
        if transport == "stdio" and os.path.basename(command) == "uvx" and args == ["paper-search-mcp"]:
            args = ["--from", "paper-search-mcp", "python", "-m", "paper_search_mcp.server"]
        env = {
            str(key): str(value)
            for key, value in (raw.get("env") or {}).items()
            if str(key).strip() and str(value).strip()
        } if isinstance(raw.get("env"), dict) else {}
        allowed_tools = [
            str(item).strip()
            for item in raw.get("allowed_tools", [])
            if str(item).strip()
        ] if isinstance(raw.get("allowed_tools"), list) else []
        if ident == "paper_search_mcp" and {"search_papers", "download_with_fallback"} & set(allowed_tools):
            allowed_tools = [
                "search_arxiv",
                "search_pubmed",
                "search_biorxiv",
                "search_medrxiv",
                "read_arxiv_paper",
            ]
        servers.append(
            McpServerConfig(
                id=ident,
                name=str(raw.get("name") or ident).strip() or ident,
                command=command,
                transport=transport,
                endpoint=endpoint,
                args=[] if transport == "remote" else args,
                env=env,
                enabled=True,
                allowed_tools=allowed_tools,
            )
        )
    return servers


async def discover_mcp_tools(runtime_config: dict[str, Any] | None) -> list[McpToolRef]:
    refs: list[McpToolRef] = []
    for server in configured_mcp_servers(runtime_config):
        try:
            tools = await _with_mcp_session(server, lambda session: session.list_tools())
        except Exception as exc:  # noqa: BLE001
            refs.append(_error_tool_ref(server, exc))
            continue

        allowed = set(server.allowed_tools)
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            tool_name = str(tool.get("name") or "").strip()
            if not tool_name or (allowed and tool_name not in allowed):
                continue
            function_name = f"mcp__{server.id}__{_safe_token(tool_name)}"
            parameters = tool.get("inputSchema")
            if not isinstance(parameters, dict):
                parameters = {"type": "object", "properties": {}}
            refs.append(
                McpToolRef(
                    function_name=function_name,
                    server=server,
                    tool_name=tool_name,
                    definition={
                        "type": "function",
                        "function": {
                            "name": function_name,
                            "description": (
                                f"MCP tool `{tool_name}` from {server.name}. "
                                + str(tool.get("description") or "")
                            )[:1024],
                            "parameters": parameters,
                        },
                    },
                )
            )
    return refs


async def call_mcp_tool(ref: McpToolRef, arguments: dict[str, Any]) -> str:
    if ref.tool_name == "__mcp_server_unavailable__":
        return json.dumps(
            {
                "error": "mcp_server_unavailable",
                "server": ref.server.name,
                "detail": ref.definition["function"]["description"],
            },
            ensure_ascii=False,
        )
    result = await _with_mcp_session(
        ref.server,
        lambda session: session.call_tool(ref.tool_name, arguments),
    )
    return _serialize_result(result)


def _error_tool_ref(server: McpServerConfig, exc: Exception) -> McpToolRef:
    function_name = f"mcp__{server.id}__status"
    return McpToolRef(
        function_name=function_name,
        server=server,
        tool_name="__mcp_server_unavailable__",
        definition={
            "type": "function",
            "function": {
                "name": function_name,
                "description": f"MCP server `{server.name}` is unavailable: {type(exc).__name__}: {exc}",
                "parameters": {"type": "object", "properties": {}},
            },
        },
    )


async def _with_mcp_session(server: McpServerConfig, fn):
    ensure_mcp_transport_allowed(server.transport)
    if server.transport == "remote":
        validate_remote_endpoint(server.endpoint or server.command)
        session = _RemoteMcpSession(server)
        try:
            await session.initialize()
            return await asyncio.wait_for(fn(session), timeout=MCP_TIMEOUT_SECONDS)
        finally:
            await session.close()

    command_name = os.path.basename(server.command)
    if command_name not in ALLOWED_COMMANDS:
        raise McpToolError(f"Command `{server.command}` is not allowed for MCP servers")

    env = os.environ.copy()
    env.update(server.env)
    proc = await asyncio.create_subprocess_exec(
        server.command,
        *server.args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    session = _McpSession(proc)
    stderr_task = asyncio.create_task(_drain_stderr(proc))
    try:
        await asyncio.wait_for(session.initialize(), timeout=MCP_TIMEOUT_SECONDS)
        return await asyncio.wait_for(fn(session), timeout=MCP_TIMEOUT_SECONDS)
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        stderr_task.cancel()


class _RemoteMcpSession:
    def __init__(self, server: McpServerConfig) -> None:
        self.server = server
        self.endpoint = server.endpoint or server.command
        self._next_id = 1
        self._client = httpx.AsyncClient(timeout=MCP_TIMEOUT_SECONDS)
        self._session_id = ""

    async def initialize(self) -> None:
        try:
            await self._request(
                "initialize",
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "SuperLeaf", "version": "0.1.0"},
                },
            )
            await self._notify("notifications/initialized", {})
        except Exception:
            await self._client.aclose()
            raise

    async def list_tools(self) -> list[dict[str, Any]]:
        result = await self._request("tools/list", {})
        tools = result.get("tools") if isinstance(result, dict) else None
        return tools if isinstance(tools, list) else []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        return await self._request("tools/call", {"name": name, "arguments": arguments})

    async def close(self) -> None:
        await self._client.aclose()

    async def _notify(self, method: str, params: dict[str, Any]) -> None:
        await self._post({"jsonrpc": "2.0", "method": method, "params": params}, expect_response=False)

    async def _request(self, method: str, params: dict[str, Any]) -> Any:
        request_id = self._next_id
        self._next_id += 1
        msg = await self._post({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        if "error" in msg:
            raise McpToolError(json.dumps(msg["error"], ensure_ascii=False))
        return msg.get("result")

    async def _post(self, payload: dict[str, Any], *, expect_response: bool = True) -> dict[str, Any]:
        headers = {
            "Accept": "application/json,text/event-stream",
            "Content-Type": "application/json",
            "Mcp-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        token = _remote_auth_token(self.server.env)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            response = await self._client.post(self.endpoint, json=payload, headers=headers)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise McpToolError(f"Remote MCP request failed: {exc}") from exc
        self._session_id = response.headers.get("mcp-session-id", self._session_id)
        if not expect_response or response.status_code == 202 or not response.content:
            return {}
        return _parse_remote_response(response)


class _McpSession:
    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self.proc = proc
        self._next_id = 1
        self._read_buffer = b""

    async def initialize(self) -> None:
        await self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "SuperLeaf", "version": "0.1.0"},
            },
        )
        await self._notify("notifications/initialized", {})

    async def list_tools(self) -> list[dict[str, Any]]:
        result = await self._request("tools/list", {})
        tools = result.get("tools") if isinstance(result, dict) else None
        return tools if isinstance(tools, list) else []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        return await self._request("tools/call", {"name": name, "arguments": arguments})

    async def _notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def _request(self, method: str, params: dict[str, Any]) -> Any:
        request_id = self._next_id
        self._next_id += 1
        await self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            msg = await self._read()
            if msg.get("id") != request_id:
                continue
            if "error" in msg:
                raise McpToolError(json.dumps(msg["error"], ensure_ascii=False))
            return msg.get("result")

    async def _send(self, payload: dict[str, Any]) -> None:
        if self.proc.stdin is None:
            raise McpToolError("MCP stdin is closed")
        raw = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        self.proc.stdin.write(raw)
        await self.proc.stdin.drain()

    async def _read(self) -> dict[str, Any]:
        if self.proc.stdout is None:
            raise McpToolError("MCP stdout is closed")
        while True:
            while b"\n" not in self._read_buffer:
                chunk = await self.proc.stdout.read(4096)
                if not chunk:
                    raise McpToolError("MCP server closed stdout")
                self._read_buffer += chunk
                if len(self._read_buffer) > 256_000:
                    # Some servers print banners or logs to stdout before the
                    # JSON-RPC stream. Keep only the tail so protocol messages
                    # can still be recovered if they arrive after the banner.
                    self._read_buffer = self._read_buffer[-64_000:]
            raw_line, self._read_buffer = self._read_buffer.split(b"\n", 1)
            text = raw_line.decode("utf-8", errors="replace").strip()
            if not text or not text.startswith("{"):
                continue
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                continue


async def _drain_stderr(proc: asyncio.subprocess.Process) -> None:
    if proc.stderr is None:
        return
    while True:
        line = await proc.stderr.readline()
        if not line:
            return


def _serialize_result(result: Any) -> str:
    text = json.dumps(result, ensure_ascii=False, default=str)
    if len(text) <= MAX_MCP_RESULT_CHARS:
        return text
    return text[:MAX_MCP_RESULT_CHARS] + "\n...[truncated]"


def _remote_auth_token(env: dict[str, str]) -> str:
    for key in ("MCP_AUTH_TOKEN", "AUTH_TOKEN", "BEARER_TOKEN", "TOKEN", "API_KEY"):
        token = str(env.get(key) or "").strip()
        if token:
            return token
    return ""


def _parse_remote_response(response: httpx.Response) -> dict[str, Any]:
    content_type = response.headers.get("content-type", "")
    text = response.text.strip()
    if "text/event-stream" in content_type or text.startswith("event:") or text.startswith("data:"):
        return _parse_sse_json(text)
    try:
        payload = response.json()
    except ValueError as exc:
        raise McpToolError("Remote MCP response is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise McpToolError("Remote MCP response must be a JSON object")
    return payload


def _parse_sse_json(text: str) -> dict[str, Any]:
    data_parts: list[str] = []
    for line in text.splitlines():
        if line.startswith("data:"):
            data = line.removeprefix("data:").strip()
            if data and data != "[DONE]":
                data_parts.append(data)
    if not data_parts:
        return {}
    try:
        payload = json.loads("\n".join(data_parts))
    except json.JSONDecodeError as exc:
        raise McpToolError("Remote MCP SSE response is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise McpToolError("Remote MCP SSE response must contain a JSON object")
    return payload


def _safe_token(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_]+", "_", value.strip())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_").lower()
    return cleaned[:48] or "mcp"

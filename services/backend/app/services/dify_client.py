"""Typed client for Dify's Workflow / Chat API.

We standardise on the following endpoints (stable across Dify 0.14+):

  POST  {endpoint}/workflows/run                     -- workflow apps
  GET   {endpoint}/workflows/run/{run_id}            -- final result
  POST  {endpoint}/chat-messages                     -- chat / advanced-chat / agent-chat apps
  GET   {endpoint}/info                              -- app self-description

`endpoint` is typically either `http://localhost:8080/v1` (self-hosted Dify) or
`https://api.dify.ai/v1` (Dify Cloud). Auth is `Authorization: Bearer <key>`.

`trust_env=False` is enforced everywhere: a desktop user may have a system
proxy (e.g. Clash on 127.0.0.1:7897) that breaks loopback traffic.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from .sse_decode import iter_sse_json_events

CHAT_MODES = {"chat", "advanced-chat", "agent-chat"}


@dataclass
class DifyAppInfo:
    name: str
    description: str
    tags: list[str]
    mode: str  # 'workflow' | 'chat' | 'advanced-chat' | 'agent-chat' | ...


class DifyError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"Dify API error {status}: {detail}")
        self.status = status
        self.detail = detail


class DifyClient:
    def __init__(self, endpoint: str, api_key: str, timeout: float = 30.0) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    async def probe(self) -> DifyAppInfo:
        """Verify the endpoint/key pair and return the app descriptor."""
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            resp = await client.get(f"{self.endpoint}/info", headers=self._headers)
            if resp.status_code != 200:
                raise DifyError(resp.status_code, resp.text[:400])
            data = resp.json()
        return DifyAppInfo(
            name=data.get("name", "Unnamed Dify app"),
            description=data.get("description", ""),
            tags=data.get("tags", []) or [],
            mode=data.get("mode", "workflow"),
        )

    # ------------------------------------------------------------------ run

    def is_chat_mode(self, mode: str) -> bool:
        return mode in CHAT_MODES

    async def run_streaming(
        self,
        *,
        mode: str,
        inputs: dict[str, Any],
        user: str,
        query: str = "",
        conversation_id: str = "",
        files: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield each SSE event as a dict.

        Dispatches to /workflows/run for workflow apps and /chat-messages for
        chat / advanced-chat / agent-chat apps. The latter accepts a `query`
        field (plain text question) and supports multi-turn via `conversation_id`.
        """
        if self.is_chat_mode(mode):
            url = f"{self.endpoint}/chat-messages"
            body: dict[str, Any] = {
                "inputs": inputs,
                "query": query or "",
                "response_mode": "streaming",
                "user": user,
                "conversation_id": conversation_id or "",
            }
        else:
            url = f"{self.endpoint}/workflows/run"
            body = {
                "inputs": inputs,
                "response_mode": "streaming",
                "user": user,
            }
        if files:
            body["files"] = files

        async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
            async with client.stream(
                "POST",
                url,
                headers={**self._headers, "Content-Type": "application/json"},
                json=body,
            ) as resp:
                if resp.status_code != 200:
                    raw = await resp.aread()
                    raise DifyError(resp.status_code, raw.decode(errors="replace")[:400])
                async for event in iter_sse_json_events(resp.aiter_raw()):
                    yield event

    async def run_blocking(
        self,
        *,
        mode: str,
        inputs: dict[str, Any],
        user: str,
        query: str = "",
        conversation_id: str = "",
        files: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if self.is_chat_mode(mode):
            url = f"{self.endpoint}/chat-messages"
            body: dict[str, Any] = {
                "inputs": inputs,
                "query": query or "",
                "response_mode": "blocking",
                "user": user,
                "conversation_id": conversation_id or "",
            }
        else:
            url = f"{self.endpoint}/workflows/run"
            body = {
                "inputs": inputs,
                "response_mode": "blocking",
                "user": user,
            }
        if files:
            body["files"] = files
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            resp = await client.post(
                url,
                headers={**self._headers, "Content-Type": "application/json"},
                json=body,
            )
            if resp.status_code != 200:
                raise DifyError(resp.status_code, resp.text[:400])
            return resp.json()

    async def run_detail(self, run_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            resp = await client.get(
                f"{self.endpoint}/workflows/run/{run_id}",
                headers=self._headers,
            )
            if resp.status_code != 200:
                raise DifyError(resp.status_code, resp.text[:400])
            return resp.json()

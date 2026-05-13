"""Typed client for Nanobot's OpenAI-compatible HTTP API.

Phase 1 keeps the integration intentionally narrow:
- probe /health and /v1/models
- stream /v1/chat/completions with response streaming
- surface raw SSE payloads to the caller so the backend can normalize them
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass(slots=True)
class NanobotModel:
    id: str
    name: str
    description: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class NanobotInfo:
    name: str
    models: list[NanobotModel]
    health: dict[str, Any] = field(default_factory=dict)


class NanobotError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"Nanobot API error {status}: {detail}")
        self.status = status
        self.detail = detail


class NanobotClient:
    def __init__(self, endpoint: str, api_key: str, timeout: float = 30.0) -> None:
        self.endpoint = _normalize_endpoint(endpoint)
        self.api_key = api_key
        self.timeout = timeout

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
        }

    def _url(self, path: str) -> str:
        return f"{self.endpoint}{path}"

    async def probe(self) -> NanobotInfo:
        health_payload: dict[str, Any] = {}
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            resp = await client.get(self._url("/health"), headers=self._headers)
            if resp.status_code not in (200, 404, 405):
                raise NanobotError(resp.status_code, resp.text[:400])
            if "json" in resp.headers.get("content-type", "").lower():
                try:
                    data = resp.json()
                    if isinstance(data, dict):
                        health_payload = data
                except ValueError:
                    health_payload = {}

        models = await self.list_models()
        display_name = (
            str(
                health_payload.get("name")
                or health_payload.get("service")
                or health_payload.get("app")
                or (models[0].name if models else "Nanobot")
            )
        )
        return NanobotInfo(name=display_name, models=models, health=health_payload)

    async def list_models(self) -> list[NanobotModel]:
        data = await self._request_json("GET", "/v1/models")
        items = _extract_model_items(data)
        models: list[NanobotModel] = []
        for item in items:
            model = _parse_model(item)
            if model is not None:
                models.append(model)
        return models

    async def run_streaming(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        session_id: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 4000,
    ) -> AsyncIterator[dict[str, Any]]:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if session_id:
            body["session_id"] = session_id

        async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
            async with client.stream(
                "POST",
                self._url("/v1/chat/completions"),
                headers={**self._headers, "Content-Type": "application/json", "Accept": "text/event-stream"},
                json=body,
            ) as resp:
                if resp.status_code != 200:
                    raw = await resp.aread()
                    raise NanobotError(resp.status_code, raw.decode(errors="replace")[:400])

                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if not payload:
                        continue
                    if payload == "[DONE]":
                        return
                    try:
                        yield json.loads(payload)
                    except json.JSONDecodeError:
                        continue

    async def _request_json(self, method: str, path: str) -> Any:
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            resp = await client.request(method, self._url(path), headers=self._headers)
            if resp.status_code != 200:
                raise NanobotError(resp.status_code, resp.text[:400])
            try:
                return resp.json()
            except ValueError as e:
                raise NanobotError(resp.status_code, resp.text[:400]) from e


def _normalize_endpoint(endpoint: str) -> str:
    cleaned = endpoint.rstrip("/")
    if cleaned.endswith("/v1"):
        cleaned = cleaned[:-3].rstrip("/")
    return cleaned


def _extract_model_items(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ("data", "models", "items"):
        value = data.get(key)
        if isinstance(value, list):
            return value
    return []


def _parse_model(item: Any) -> NanobotModel | None:
    if isinstance(item, str):
        ident = item.strip()
        if not ident:
            return None
        return NanobotModel(id=ident, name=ident, raw={"id": ident})
    if not isinstance(item, dict):
        return None

    ident = str(item.get("id") or item.get("model") or item.get("name") or "").strip()
    if not ident:
        return None
    name = str(item.get("name") or ident).strip() or ident
    description = str(item.get("description") or item.get("summary") or "")
    return NanobotModel(id=ident, name=name, description=description, raw=item)

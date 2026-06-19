from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from ..settings import settings

INTERNAL_TOKEN_HEADER = "x-superleaf-internal-token"
UNINITIALIZED_DOC_CODE = "collab_doc_not_initialized"


class CollabGatewayError(RuntimeError):
    """Raised when the collaboration service cannot provide authoritative state."""


@dataclass(slots=True)
class CollabDocText:
    doc_id: str
    text: str
    initialized: bool
    source: str


class CollabGateway:
    def __init__(
        self,
        *,
        base_url: str | None = None,
        internal_token: str | None = None,
        timeout_s: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = (base_url or settings.collab_server_url).rstrip("/")
        self.internal_token = (
            internal_token if internal_token is not None else settings.resolved_collab_internal_token()
        ).strip()
        self.timeout_s = timeout_s
        self.transport = transport

    async def get_active_doc_ids(self) -> list[str]:
        payload = await self._request_json("GET", "/docs/active")
        doc_ids = payload.get("doc_ids")
        if not isinstance(doc_ids, list):
            raise CollabGatewayError("collab active-doc response is malformed")
        return [doc_id for doc_id in doc_ids if isinstance(doc_id, str) and doc_id]

    async def get_doc_text(self, doc_id: str) -> CollabDocText | None:
        payload = await self._request_json(
            "GET",
            f"/docs/{doc_id}/text",
            none_codes={UNINITIALIZED_DOC_CODE},
        )
        if payload is None or payload.get("initialized") is False:
            return None
        text = payload.get("text")
        if not isinstance(text, str):
            raise CollabGatewayError(f"collab text response for {doc_id} is malformed")
        return CollabDocText(
            doc_id=str(payload.get("doc_id") or doc_id),
            text=text,
            initialized=bool(payload.get("initialized", True)),
            source=str(payload.get("source") or "unknown"),
        )

    async def replace_doc_text(
        self,
        doc_id: str,
        text: str,
        *,
        collab_generation: int | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"text": text}
        if collab_generation is not None:
            body["collab_generation"] = collab_generation
        payload = await self._request_json("PUT", f"/docs/{doc_id}/text", json=body)
        if payload is None:
            raise CollabGatewayError(f"collab replace response for {doc_id} is empty")
        if payload.get("ok") is not True:
            raise CollabGatewayError(f"collab replace response for {doc_id} is not ok")
        return {
            "doc_id": str(payload.get("doc_id") or doc_id),
            "length": int(payload.get("length") or 0),
            "active": bool(payload.get("active", False)),
            "connections_closed": int(payload.get("connections_closed") or 0),
        }

    async def invalidate_doc(self, doc_id: str) -> dict[str, Any]:
        payload = await self._request_json("POST", f"/docs/{doc_id}/invalidate")
        if payload is None:
            raise CollabGatewayError(f"collab invalidate response for {doc_id} is empty")
        if payload.get("ok") is not True:
            raise CollabGatewayError(f"collab invalidate response for {doc_id} is not ok")
        return {
            "doc_id": str(payload.get("doc_id") or doc_id),
            "active": bool(payload.get("active", False)),
            "connections_closed": int(payload.get("connections_closed") or 0),
            "cleared": bool(payload.get("cleared", False)),
        }

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        none_codes: set[str] | None = None,
    ) -> dict[str, Any] | None:
        if not self.internal_token:
            raise CollabGatewayError("collab internal token is not configured")
        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s, transport=self.transport) as client:
                resp = await client.request(
                    method,
                    url,
                    headers={INTERNAL_TOKEN_HEADER: self.internal_token},
                    json=json,
                )
        except httpx.HTTPError as exc:
            raise CollabGatewayError(f"failed to reach collab service at {url}") from exc

        if resp.status_code >= 400:
            code = _error_code(resp)
            if code and none_codes and code in none_codes:
                return None
            raise CollabGatewayError(f"collab service returned HTTP {resp.status_code} for {path}")

        try:
            payload = resp.json()
        except ValueError as exc:
            raise CollabGatewayError(f"collab service returned invalid JSON for {path}") from exc
        if not isinstance(payload, dict):
            raise CollabGatewayError(f"collab service returned non-object JSON for {path}")
        return payload


def _error_code(resp: httpx.Response) -> str:
    try:
        payload = resp.json()
    except ValueError:
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("code") or "")

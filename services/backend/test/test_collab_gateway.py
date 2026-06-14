from __future__ import annotations

import httpx
import pytest

from app.services import collab_snapshot_service
from app.services.collab_gateway import CollabGateway, CollabGatewayError


@pytest.mark.asyncio
async def test_gateway_fetches_active_doc_ids() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/docs/active"
        assert request.headers["x-superleaf-internal-token"] == "secret"
        return httpx.Response(200, json={"doc_ids": ["a", "b"], "count": 2})

    gateway = CollabGateway(
        base_url="http://collab.test",
        internal_token="secret",
        transport=httpx.MockTransport(handler),
    )

    assert await gateway.get_active_doc_ids() == ["a", "b"]


@pytest.mark.asyncio
async def test_gateway_fetches_doc_text() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/docs/doc-1/text"
        return httpx.Response(
            200,
            json={
                "doc_id": "doc-1",
                "text": "authoritative text",
                "length": 18,
                "initialized": True,
                "source": "loaded",
            },
        )

    gateway = CollabGateway(
        base_url="http://collab.test",
        internal_token="secret",
        transport=httpx.MockTransport(handler),
    )

    result = await gateway.get_doc_text("doc-1")

    assert result is not None
    assert result.doc_id == "doc-1"
    assert result.text == "authoritative text"
    assert result.initialized is True
    assert result.source == "loaded"


@pytest.mark.asyncio
async def test_gateway_replaces_doc_text() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "PUT"
        assert request.url.path == "/docs/doc-1/text"
        assert request.headers["x-superleaf-internal-token"] == "secret"
        assert request.headers["content-type"] == "application/json"
        assert request.content == b'{"text":"authoritative replacement"}'
        return httpx.Response(
            200,
            json={
                "ok": True,
                "doc_id": "doc-1",
                "length": 25,
                "active": True,
            },
        )

    gateway = CollabGateway(
        base_url="http://collab.test",
        internal_token="secret",
        transport=httpx.MockTransport(handler),
    )

    result = await gateway.replace_doc_text("doc-1", "authoritative replacement")

    assert result == {
        "doc_id": "doc-1",
        "length": 25,
        "active": True,
        "connections_closed": 0,
    }


@pytest.mark.asyncio
async def test_gateway_invalidates_doc_room() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/docs/doc-1/invalidate"
        assert request.headers["x-superleaf-internal-token"] == "secret"
        return httpx.Response(
            200,
            json={
                "ok": True,
                "doc_id": "doc-1",
                "active": True,
                "connections_closed": 2,
                "cleared": True,
            },
        )

    gateway = CollabGateway(
        base_url="http://collab.test",
        internal_token="secret",
        transport=httpx.MockTransport(handler),
    )

    result = await gateway.invalidate_doc("doc-1")

    assert result == {
        "doc_id": "doc-1",
        "active": True,
        "connections_closed": 2,
        "cleared": True,
    }


@pytest.mark.asyncio
async def test_gateway_returns_none_for_uninitialized_doc() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"code": "collab_doc_not_initialized"})

    gateway = CollabGateway(
        base_url="http://collab.test",
        internal_token="secret",
        transport=httpx.MockTransport(handler),
    )

    assert await gateway.get_doc_text("doc-1") is None


@pytest.mark.asyncio
async def test_gateway_raises_on_unhealthy_response() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="down")

    gateway = CollabGateway(
        base_url="http://collab.test",
        internal_token="secret",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(CollabGatewayError):
        await gateway.get_active_doc_ids()


@pytest.mark.asyncio
async def test_snapshot_service_fetches_active_docs_through_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created_with: list[str | None] = []

    class FakeGateway:
        def __init__(self, *, base_url: str | None = None) -> None:
            created_with.append(base_url)

        async def get_active_doc_ids(self) -> list[str]:
            return ["doc-from-gateway"]

    monkeypatch.setattr(collab_snapshot_service, "CollabGateway", FakeGateway, raising=False)

    ids = await collab_snapshot_service._fetch_active_doc_ids("http://collab.test")

    assert ids == ["doc-from-gateway"]
    assert created_with == ["http://collab.test"]

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from app.services.collab_gateway import CollabGateway
from app.settings import settings


@pytest.mark.asyncio
async def test_collab_gateway_reads_internal_token_from_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    token_file = tmp_path / "collab.token"
    token_file.write_text("file-secret-token\n", encoding="utf-8")
    captured_headers: dict[str, str] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured_headers.update({key.lower(): value for key, value in request.headers.items()})
        return httpx.Response(200, json={"doc_ids": []})

    monkeypatch.setattr(settings, "collab_internal_token", "")
    monkeypatch.setattr(settings, "collab_internal_token_file", str(token_file), raising=False)

    gateway = CollabGateway(
        base_url="http://collab.local",
        transport=httpx.MockTransport(handler),
    )

    assert await gateway.get_active_doc_ids() == []
    assert captured_headers["x-superleaf-internal-token"] == "file-secret-token"

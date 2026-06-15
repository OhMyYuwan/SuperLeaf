from __future__ import annotations

import pytest

from app.services import native_agent_runner as runner_module
from app.services.native_agent_runner import (
    NativeAgentRunner,
    NativeAgentRuntimeConfig,
    NativeRunPayload,
)
from app.services.sse_decode import iter_sse_json_events


@pytest.mark.asyncio
async def test_sse_byte_stream_tolerates_invalid_utf8() -> None:
    async def chunks():
        yield b"data: {\"event\":\"message\",\"answer\":\"ok\"}\n\n"
        yield b"data: {\"event\":\"message\",\"answer\":\"bad-\xa3-byte\"}\n\n"
        yield b"data: {\"event\":\"message\",\"answer\":\"still ok\"}\n\n"
        yield b"data: [DONE]\n\n"

    events = [event async for event in iter_sse_json_events(chunks())]

    assert [event["answer"] for event in events] == ["ok", "bad-�-byte", "still ok"]


@pytest.mark.asyncio
async def test_native_agent_tool_decode_error_is_sanitized(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_db_tool(*_args: object, **_kwargs: object) -> None:
        raise UnicodeDecodeError("utf-8", b"abc\xa3", 3, 4, "invalid start byte")

    monkeypatch.setattr(runner_module, "execute_native_agent_local_tool", lambda *_args: None)
    monkeypatch.setattr(runner_module, "execute_native_agent_db_tool", fail_db_tool)

    runner = NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id="agent-a",
            agent_name="Agent A",
            provider_endpoint="http://localhost",
            api_key="test-key",
            model="test-model",
            instructions="",
            workspace_root="/tmp",
            project_id="project-a",
            user_id="user-a",
        )
    )

    result = await runner._execute_tool(
        {"function": {"name": "project_read_doc", "arguments": "{}"}},
        {},
        NativeRunPayload(
            document_id="doc-a",
            range_start=0,
            range_end=0,
            inputs={},
            query="read it",
        ),
    )

    assert result.failed is True
    assert "UTF-8" in result.content
    assert "UnicodeDecodeError" not in result.content
    assert "codec can't decode" not in result.content
    assert "0xa3" not in result.content.lower()

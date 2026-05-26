import json

import pytest

from app.services import native_agent_runner as runner_module
from app.services.mcp_tool_service import McpServerConfig, McpToolRef
from app.services.native_agent_runner import NativeAgentRunner, NativeAgentRuntimeConfig


def _runner(tmp_path) -> NativeAgentRunner:
    return NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id="agent1",
            agent_name="Researcher",
            provider_endpoint="http://localhost",
            api_key="test",
            model="test-model",
            instructions="",
            workspace_root=str(tmp_path),
        )
    )


def _mcp_ref() -> McpToolRef:
    return McpToolRef(
        function_name="mcp__semantic_scholar__search_papers",
        server=McpServerConfig(
            id="semantic_scholar",
            name="akapet00@semantic-scholar",
            command="uvx",
        ),
        tool_name="search_papers",
        definition={
            "type": "function",
            "function": {
                "name": "mcp__semantic_scholar__search_papers",
                "description": "Search papers",
                "parameters": {"type": "object", "properties": {}},
            },
        },
    )


def _tool_call(arguments: dict | None = None) -> dict:
    return {
        "id": "call-1",
        "type": "function",
        "function": {
            "name": "mcp__semantic_scholar__search_papers",
            "arguments": json.dumps(arguments or {"query": "RAGAS evaluation"}),
        },
    }


@pytest.mark.asyncio
async def test_mcp_exception_returns_agent_visible_failure(monkeypatch, tmp_path):
    ref = _mcp_ref()

    async def fail_mcp(_ref, _arguments):
        raise RuntimeError("Rate limit exceeded for /paper/search")

    monkeypatch.setattr(runner_module, "call_mcp_tool", fail_mcp)

    result = await _runner(tmp_path)._execute_tool(_tool_call(), {ref.function_name: ref})
    payload = json.loads(result.content)

    assert result.failed is True
    assert result.failed_function_name == ref.function_name
    assert result.tool_kind == "mcp"
    assert payload["status"] == "failed"
    assert payload["error_type"] == "rate_limited"
    assert "API key" in payload["user_action"]
    assert "check MCP configuration" in payload["agent_instruction"]


@pytest.mark.asyncio
async def test_mcp_serialized_error_result_returns_agent_visible_failure(monkeypatch, tmp_path):
    ref = _mcp_ref()

    async def mcp_error_result(_ref, _arguments):
        return json.dumps(
            {
                "content": [
                    {
                        "type": "text",
                        "text": "Error calling tool 'search_papers': Rate limit exceeded for /paper/search",
                    }
                ],
                "isError": True,
            }
        )

    monkeypatch.setattr(runner_module, "call_mcp_tool", mcp_error_result)

    result = await _runner(tmp_path)._execute_tool(_tool_call(), {ref.function_name: ref})
    payload = json.loads(result.content)

    assert result.failed is True
    assert payload["error_type"] == "rate_limited"
    assert "Rate limit exceeded" in payload["detail"]


@pytest.mark.asyncio
async def test_mcp_tool_remains_callable_after_failure(monkeypatch, tmp_path):
    ref = _mcp_ref()
    calls = 0

    async def fail_mcp(_ref, _arguments):
        nonlocal calls
        calls += 1
        raise RuntimeError("Forbidden: anonymous access quota exceeded")

    monkeypatch.setattr(runner_module, "call_mcp_tool", fail_mcp)

    first = await _runner(tmp_path)._execute_tool(_tool_call(), {ref.function_name: ref})
    second = await _runner(tmp_path)._execute_tool(_tool_call(), {ref.function_name: ref})
    first_payload = json.loads(first.content)
    second_payload = json.loads(second.content)

    assert calls == 2
    assert first.failed is True
    assert second.failed is True
    assert first_payload["error_type"] == "rate_limited"
    assert second_payload["error_type"] == "rate_limited"

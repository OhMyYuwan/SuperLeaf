import json

import pytest

from app.services import native_agent_runner as runner_module
from app.services.native_agent_runner import (
    NativeAgentRunner,
    NativeAgentRuntimeConfig,
    NativeRunPayload,
    NativeSkillBlock,
)


def _skill() -> NativeSkillBlock:
    return NativeSkillBlock(
        id="skill-paper-review",
        name="Paper Review",
        version=3,
        source="upload",
        description="Use when reviewing paper logic and evidence.",
        tags=["review", "paper"],
        content="# Paper Review\n\nSecret full rubric text.",
        content_hash="sha256:testhash",
    )


def _runner(tmp_path, *, skills: list[NativeSkillBlock] | None = None) -> NativeAgentRunner:
    return NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id="agent1",
            agent_name="Reviewer",
            provider_endpoint="http://localhost",
            api_key="test",
            model="test-model",
            instructions="",
            skills=skills or [],
            workspace_root=str(tmp_path),
        )
    )


def _payload(*, prior_messages: list[dict] | None = None) -> NativeRunPayload:
    return NativeRunPayload(
        document_id="doc1",
        range_start=0,
        range_end=10,
        inputs={"target_text": "intro text", "instruction": "Check logic gaps."},
        conversation_id="conv1",
        prior_messages=prior_messages or [],
    )


@pytest.mark.asyncio
async def test_skill_prompt_exposes_metadata_without_full_content(tmp_path):
    runner = _runner(tmp_path, skills=[_skill()])

    prompt = runner._system_prompt(_payload())

    assert "Available Skills:" in prompt
    assert "skill-paper-review: Paper Review v3" in prompt
    assert "Use when reviewing paper logic and evidence." in prompt
    assert "use_skill(skill_id, reason)" in prompt
    assert "Secret full rubric text" not in prompt


@pytest.mark.asyncio
async def test_use_skill_returns_content_and_activation_payload(tmp_path):
    runner = _runner(tmp_path, skills=[_skill()])
    call = {
        "id": "call-1",
        "type": "function",
        "function": {
            "name": "use_skill",
            "arguments": json.dumps(
                {
                    "skill_id": "skill-paper-review",
                    "reason": "Need paper review rubric.",
                }
            ),
        },
    }

    result = await runner._execute_tool(call, {}, _payload())

    assert result.failed is False
    assert result.tool_kind == "skill"
    assert "Secret full rubric text" in result.content
    assert result.trace_payload == {
        "skill_id": "skill-paper-review",
        "skill_name": "Paper Review",
        "skill_version": 3,
        "skill_source": "upload",
        "skill_cache_version": 0,
        "description": "Use when reviewing paper logic and evidence.",
        "tags": ["review", "paper"],
        "content_hash": "sha256:testhash",
        "reason": "Need paper review rubric.",
    }


@pytest.mark.asyncio
async def test_use_skill_stream_emits_activation_event(monkeypatch, tmp_path):
    captured: dict[str, object] = {"calls": 0}

    async def no_mcp(_runtime_config):
        return []

    class FakeNanobotClient:
        def __init__(self, *args, **kwargs):
            pass

        async def run_streaming(self, **kwargs):
            captured["calls"] = int(captured["calls"]) + 1
            if captured["calls"] == 1:
                captured["first_messages"] = kwargs["messages"]
                yield {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call-1",
                                        "type": "function",
                                        "function": {
                                            "name": "use_skill",
                                            "arguments": json.dumps(
                                                {
                                                    "skill_id": "skill-paper-review",
                                                    "reason": "Need rubric.",
                                                }
                                            ),
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                }
                return
            captured["second_messages"] = kwargs["messages"]
            yield {"choices": [{"delta": {"content": "Done."}}]}

    monkeypatch.setattr(runner_module, "discover_mcp_tools", no_mcp)
    monkeypatch.setattr(runner_module, "NanobotClient", FakeNanobotClient)

    events = [event async for event in _runner(tmp_path, skills=[_skill()]).stream(_payload())]

    activation_events = [event for event in events if event["event"] == "native.agent.skill.activated"]
    assert len(activation_events) == 1
    assert activation_events[0]["data"]["skill_id"] == "skill-paper-review"
    assert activation_events[0]["data"]["reason"] == "Need rubric."
    second_messages = captured["second_messages"]
    assert isinstance(second_messages, list)
    assert any(
        message.get("role") == "tool" and "Secret full rubric text" in message.get("content", "")
        for message in second_messages
    )


@pytest.mark.asyncio
async def test_workflow_chat_with_skills_only_exposes_use_skill_tool(monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    class FakeNanobotClient:
        def __init__(self, *args, **kwargs):
            pass

        async def run_streaming(self, **kwargs):
            captured.update(kwargs)
            yield {"choices": [{"delta": {"content": "ok"}}]}

    monkeypatch.setattr(runner_module, "NanobotClient", FakeNanobotClient)

    events = [
        event
        async for event in _runner(tmp_path, skills=[_skill()]).stream(
            _payload(prior_messages=[{"role": "user", "content": "workflow input"}])
        )
    ]

    tool_names = [
        tool["function"]["name"]
        for tool in captured["tools"]
        if isinstance(tool, dict) and isinstance(tool.get("function"), dict)
    ]
    assert tool_names == ["use_skill"]
    assert events[-1]["event"] == "native.agent.output.delta"

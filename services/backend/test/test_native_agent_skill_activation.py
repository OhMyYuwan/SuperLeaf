import json
from pathlib import Path

import pytest

from app.services import native_agent_runner as runner_module
from app.services.native_agent_runner import (
    NativeAgentRunner,
    NativeAgentRuntimeConfig,
    NativeRunPayload,
    NativeSkillBlock,
)


def _make_skill_dir(tmp_path: Path, folder_name: str = "Paper-Review", content: str = "# Paper Review\n\nSecret full rubric text.") -> Path:
    """Create a skill folder with SKILL.md and optional references on disk."""
    skill_dir = tmp_path / ".agents" / "skills" / folder_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
    refs = skill_dir / "references"
    refs.mkdir(exist_ok=True)
    (refs / "rubric.md").write_text("Detailed rubric content.", encoding="utf-8")
    return skill_dir


def _skill(*, aliases: list[str] | None = None, folder_name: str = "Paper-Review") -> NativeSkillBlock:
    return NativeSkillBlock(
        id=folder_name,
        name=folder_name,
        version=1,
        source="workspace",
        aliases=aliases or [folder_name],
        description="",
        tags=[],
        content="",
        folder_path=f"skills/{folder_name}",
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
    _make_skill_dir(tmp_path)
    runner = _runner(tmp_path, skills=[_skill()])

    prompt = runner._system_prompt(_payload())

    assert "Available Skills:" in prompt
    assert "Paper-Review: Paper-Review v1" in prompt
    assert "use_skill(skill_id, reason)" in prompt
    assert "Secret full rubric text" not in prompt


def test_prompt_audit_payload_records_system_and_user_prompts(tmp_path):
    _make_skill_dir(tmp_path)
    runner = _runner(tmp_path, skills=[_skill()])

    audit = runner.prompt_audit_payload(_payload())

    assert audit["message_count"] == 2
    assert "Available Skills:" in audit["system_prompt"]
    assert "User instruction:" in audit["user_prompt"]
    assert "Check logic gaps." in audit["user_prompt"]
    assert "intro text" in audit["user_prompt"]
    assert audit["prior_messages"] == []
    assert "Secret full rubric text" not in audit["system_prompt"]


@pytest.mark.asyncio
async def test_use_skill_returns_content_and_activation_payload(tmp_path):
    _make_skill_dir(tmp_path, content="# Paper Review\n\nSecret full rubric text.")
    runner = _runner(tmp_path, skills=[_skill()])
    call = {
        "id": "call-1",
        "type": "function",
        "function": {
            "name": "use_skill",
            "arguments": json.dumps(
                {
                    "skill_id": "Paper-Review",
                    "reason": "Need paper review rubric.",
                }
            ),
        },
    }

    result = await runner._execute_tool(call, {}, _payload())

    assert result.failed is False
    assert result.tool_kind == "skill"
    assert "Secret full rubric text" in result.content
    assert "Files in this Skill:" in result.content
    assert "SKILL.md" in result.content
    assert "references/rubric.md" in result.content
    assert result.trace_payload is not None
    assert result.trace_payload["skill_id"] == "Paper-Review"
    assert result.trace_payload["reason"] == "Need paper review rubric."


@pytest.mark.asyncio
async def test_use_skill_accepts_folder_name_as_alias(tmp_path):
    _make_skill_dir(tmp_path, folder_name="Q1ngsong@phd-mentor")
    runner = _runner(tmp_path, skills=[_skill(aliases=["Q1ngsong@phd-mentor"], folder_name="Q1ngsong@phd-mentor")])
    call = {
        "id": "call-1",
        "type": "function",
        "function": {
            "name": "use_skill",
            "arguments": json.dumps(
                {
                    "skill_id": "Q1ngsong@phd-mentor",
                    "reason": "Use the visible Skill folder name.",
                }
            ),
        },
    }

    result = await runner._execute_tool(call, {}, _payload())

    assert result.failed is False
    assert result.tool_kind == "skill"
    assert "Secret full rubric text" in result.content
    assert "Files in this Skill:" in result.content
    assert result.trace_payload is not None
    assert result.trace_payload["skill_id"] == "Q1ngsong@phd-mentor"


@pytest.mark.asyncio
async def test_use_skill_stream_emits_activation_event(monkeypatch, tmp_path):
    _make_skill_dir(tmp_path)
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
                                                    "skill_id": "Paper-Review",
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
    assert activation_events[0]["data"]["skill_id"] == "Paper-Review"
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

from types import SimpleNamespace

import pytest

from app.services import native_agent_runner as runner_module
from app.services.agent_orchestrator import (
    NodeContext,
    WorkflowOrchestrator,
    _append_agent_turn,
    _chat_log_to_messages,
    _messages_to_text_prompt,
    _node_allows_project_context,
    _seed_chat_from_input_node,
)
from app.services.native_agent_runner import (
    NativeAgentRunner,
    NativeAgentRuntimeConfig,
    NativeRunPayload,
)


def test_workflow_chat_log_projects_input_and_agent_turns():
    ctx = SimpleNamespace(
        chat_log=[],
        workflow_def=SimpleNamespace(
            graph={
                "nodes": [
                    {"id": "input1", "type": "input", "config": {"_ui": {}}},
                    {
                        "id": "agent1",
                        "type": "agent",
                        "config": {"_ui": {"parent_id": "loop1"}},
                    },
                ]
            }
        ),
    )

    _seed_chat_from_input_node(
        ctx,
        "input1",
        {"user_instruction": "请分析文本", "target_text": "第一段内容"},
        include_instruction=True,
    )
    _append_agent_turn(
        ctx,
        NodeContext(
            node_id="agent1",
            node_type="agent",
            config={},
            inputs={"current_round": 2},
        ),
        agent_id="agent-a",
        agent_name="Reviewer",
        text="<think>hidden scratchpad</think>公开结论",
    )

    assert ctx.chat_log[1]["loop_id"] == "loop1"
    assert ctx.chat_log[1]["content"] == "公开结论"
    assert _chat_log_to_messages(ctx.chat_log) == [
        {"role": "user", "content": "请分析文本\n\n第一段内容"},
        {"role": "assistant", "content": "[agent1 round 2]\n公开结论"},
    ]


def test_dify_text_prompt_wraps_prior_messages_and_current_context():
    prompt = _messages_to_text_prompt(
        [
            {"role": "user", "content": "输入节点内容"},
            {"role": "assistant", "content": "[agent1]\n上一位 Agent 的输出"},
        ],
        "当前节点只输出自己的判断",
    )

    assert "[PRIOR MESSAGES]" in prompt
    assert "USER:\n输入节点内容" in prompt
    assert "ASSISTANT:\n[agent1]\n上一位 Agent 的输出" in prompt
    assert "[CURRENT NODE CONTEXT]" in prompt
    assert "当前节点只输出自己的判断" in prompt


def test_agent_prompt_uses_group_chat_mode_without_duplicating_selected_text():
    orchestrator = WorkflowOrchestrator.__new__(WorkflowOrchestrator)
    ctx = SimpleNamespace(
        db=None,
        document_id="doc1",
        user_instruction="原始用户指令",
        target_text="原始选中文本",
        context_files=[],
        workflow_run=SimpleNamespace(max_rounds=3),
    )
    node = NodeContext(
        node_id="agent2",
        node_type="agent",
        config={"additional_prompt": "继续上一位 Agent 的判断，只输出结论。"},
        inputs={"prior_messages": [{"role": "user", "content": "原始用户指令\n\n原始选中文本"}]},
    )

    prompt = orchestrator._build_agent_prompt(ctx, node)

    assert "Read prior_messages as the shared group-chat history" in prompt
    assert "original user task inside prior_messages has highest priority" in prompt
    assert "lower-priority role or format guidance" in prompt
    assert "Speaker labels such as [node round N]" in prompt
    assert "继续上一位 Agent 的判断，只输出结论。" in prompt
    assert "Node-specific role/format guidance" in prompt
    assert "User instruction: 原始用户指令" not in prompt
    assert "Target text:" not in prompt


def test_agent_prompt_ignores_legacy_prompt_hint_runtime_text():
    orchestrator = WorkflowOrchestrator.__new__(WorkflowOrchestrator)
    ctx = SimpleNamespace(
        db=None,
        document_id="doc1",
        user_instruction="原始用户指令",
        target_text="原始选中文本",
        context_files=[],
        workflow_run=SimpleNamespace(max_rounds=3),
    )
    node = NodeContext(
        node_id="agent2",
        node_type="agent",
        config={"promptHint": "这是旧版隐藏提示词，不应被运行时注入。"},
        inputs={"prior_messages": [{"role": "user", "content": "原始用户指令\n\n原始选中文本"}]},
    )

    prompt = orchestrator._build_agent_prompt(ctx, node)

    assert "这是旧版隐藏提示词，不应被运行时注入。" not in prompt
    assert "Node-specific role/format guidance" not in prompt


def test_native_user_prompt_uses_prior_messages_as_selected_text_source():
    runner = NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id="agent1",
            agent_name="Reviewer",
            provider_endpoint="http://localhost",
            api_key="test",
            model="test-model",
            instructions="",
        )
    )
    payload = NativeRunPayload(
        document_id="doc1",
        range_start=10,
        range_end=20,
        inputs={
            "target_text": "不应再次复制的选中文本",
            "instruction": "当前节点上下文",
            "before": "前文",
            "after": "后文",
        },
        prior_messages=[{"role": "user", "content": "群聊中的原始输入"}],
    )

    prompt = runner._user_prompt(payload)

    assert "Document id: doc1" not in prompt
    assert "Selected range: 10-20" not in prompt
    assert "当前节点上下文" in prompt
    assert "User instruction:" not in prompt
    assert "Selected text:" not in prompt
    assert "不应再次复制的选中文本" not in prompt
    assert "Surrounding context:" not in prompt


def test_native_system_prompt_in_workflow_chat_forbids_hidden_document_context():
    runner = NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id="agent1",
            agent_name="Reviewer",
            provider_endpoint="http://localhost",
            api_key="test",
            model="test-model",
            instructions="",
            workspace_root="/tmp/agent-workspace",
        )
    )
    payload = NativeRunPayload(
        document_id="doc1",
        range_start=0,
        range_end=5,
        inputs={"instruction": "当前节点上下文"},
        prior_messages=[{"role": "user", "content": "群聊中的原始输入"}],
    )

    prompt = runner._system_prompt(payload)

    assert "workflow group chat" in prompt
    assert "Use only the provided prior messages" in prompt
    assert "original user task inside prior messages has highest priority" in prompt
    assert "Speaker labels such as [node round N]" in prompt
    assert "project_read_doc" not in prompt
    assert "project_grep" not in prompt
    assert "propose_doc_edit" not in prompt


def test_native_project_context_opt_in_explains_read_only_tools():
    runner = NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id="agent1",
            agent_name="Reviewer",
            provider_endpoint="http://localhost",
            api_key="test",
            model="test-model",
            instructions="",
            workspace_root="/tmp/agent-workspace",
        )
    )
    payload = NativeRunPayload(
        document_id="doc1",
        range_start=0,
        range_end=5,
        inputs={"instruction": "读取当前文档后总结"},
        prior_messages=[{"role": "user", "content": "群聊中的原始输入"}],
        allow_project_context=True,
    )

    system_prompt = runner._system_prompt(payload)
    user_prompt = runner._user_prompt(payload)

    assert "Read-only project document tools are available" in system_prompt
    assert "Use project tools only when" in system_prompt
    assert "Project context access: enabled" in user_prompt
    assert "Active document id: doc1" in user_prompt
    assert "Selected range: 0-5" in user_prompt


def test_node_allows_project_context_from_config_or_explicit_prompt():
    explicit = NodeContext(
        node_id="agent1",
        node_type="agent",
        config={"allow_project_context": True},
    )
    prompt_intent = NodeContext(
        node_id="agent2",
        node_type="agent",
        config={"additional_prompt": "请读取当前文档后再判断。"},
    )
    plain = NodeContext(
        node_id="agent3",
        node_type="agent",
        config={"additional_prompt": "继续上一位 Agent 的报数。"},
    )
    legacy_prompt_hint = NodeContext(
        node_id="agent4",
        node_type="agent",
        config={"promptHint": "请读取当前文档后再判断。"},
    )

    assert _node_allows_project_context(explicit) is True
    assert _node_allows_project_context(prompt_intent) is True
    assert _node_allows_project_context(plain) is False
    assert _node_allows_project_context(legacy_prompt_hint) is False


@pytest.mark.asyncio
async def test_native_stream_places_prior_messages_before_current_node_prompt(monkeypatch):
    captured: dict[str, list[dict]] = {}

    class FakeNanobotClient:
        def __init__(self, *args, **kwargs):
            pass

        async def run_streaming(self, **kwargs):
            captured["messages"] = kwargs["messages"]
            yield {"choices": [{"delta": {"content": "ok"}}]}

    monkeypatch.setattr(runner_module, "NanobotClient", FakeNanobotClient)

    runner = NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id="agent1",
            agent_name="Reviewer",
            provider_endpoint="http://localhost",
            api_key="test",
            model="test-model",
            instructions="",
        )
    )
    prior_messages = [
        {"role": "user", "content": "输入节点内容"},
        {"role": "assistant", "content": "[agent1]\n上一轮输出"},
    ]
    payload = NativeRunPayload(
        document_id="doc1",
        range_start=0,
        range_end=5,
        inputs={"target_text": "输入节点内容", "instruction": "当前节点上下文"},
        prior_messages=prior_messages,
    )

    events = [event async for event in runner.stream(payload)]

    assert [event["event"] for event in events][-1] == "native.agent.output.delta"
    assert captured["messages"][0]["role"] == "system"
    assert captured["messages"][1:3] == prior_messages
    assert captured["messages"][-1]["role"] == "user"
    assert "当前节点上下文" in captured["messages"][-1]["content"]


@pytest.mark.asyncio
async def test_native_workflow_chat_stream_skips_tools_and_hidden_session(monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    class FakeNanobotClient:
        def __init__(self, *args, **kwargs):
            pass

        async def run_streaming(self, **kwargs):
            captured.update(kwargs)
            yield {"choices": [{"delta": {"content": "ok"}}]}

    monkeypatch.setattr(runner_module, "NanobotClient", FakeNanobotClient)

    runner = NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id="agent1",
            agent_name="Reviewer",
            provider_endpoint="http://localhost",
            api_key="test",
            model="test-model",
            instructions="",
            workspace_root=str(tmp_path),
        )
    )
    payload = NativeRunPayload(
        document_id="doc1",
        range_start=0,
        range_end=5,
        inputs={"target_text": "不应读取的文档内容", "instruction": "当前节点上下文"},
        conversation_id="hidden-session-id",
        prior_messages=[{"role": "user", "content": "输入节点内容"}],
    )

    events = [event async for event in runner.stream(payload)]

    assert [event["event"] for event in events][-1] == "native.agent.output.delta"
    assert captured["session_id"] is None
    assert "tools" not in captured
    assert "Document id:" not in captured["messages"][-1]["content"]
    assert "不应读取的文档内容" not in captured["messages"][-1]["content"]


@pytest.mark.asyncio
async def test_native_workflow_project_context_opt_in_exposes_read_only_tools(monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    class FakeNanobotClient:
        def __init__(self, *args, **kwargs):
            pass

        async def run_streaming(self, **kwargs):
            captured.update(kwargs)
            yield {"choices": [{"delta": {"content": "ok"}}]}

    monkeypatch.setattr(runner_module, "NanobotClient", FakeNanobotClient)

    runner = NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id="agent1",
            agent_name="Reviewer",
            provider_endpoint="http://localhost",
            api_key="test",
            model="test-model",
            instructions="",
            workspace_root=str(tmp_path),
        )
    )
    payload = NativeRunPayload(
        document_id="doc1",
        range_start=0,
        range_end=5,
        inputs={"target_text": "原始文档片段", "instruction": "读取当前文档后总结"},
        conversation_id="hidden-session-id",
        prior_messages=[{"role": "user", "content": "输入节点内容"}],
        allow_project_context=True,
    )

    events = [event async for event in runner.stream(payload)]
    tool_names = {
        tool["function"]["name"]
        for tool in captured["tools"]
        if isinstance(tool, dict) and isinstance(tool.get("function"), dict)
    }

    assert [event["event"] for event in events][-1] == "native.agent.output.delta"
    assert captured["session_id"] is None
    assert {"project_list_docs", "project_read_doc", "project_grep", "project_outline"} <= tool_names
    assert "propose_doc_edit" not in tool_names
    assert "read_agent_file" not in tool_names
    assert "Project context access: enabled" in captured["messages"][-1]["content"]

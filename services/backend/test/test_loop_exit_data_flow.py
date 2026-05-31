from types import MethodType, SimpleNamespace

import pytest

from app.services.agent_orchestrator import (
    NodeContext,
    WorkflowOrchestrator,
    _dependency_output_aliases_for_node,
    _dependency_outputs_for_node,
    _select_loop_feedback,
)


def test_loop_dependency_expands_to_exit_child_output():
    ctx = SimpleNamespace(
        nodes={
            "L1": SimpleNamespace(node_type="loop"),
            "after": SimpleNamespace(node_type="agent"),
        }
    )
    completed = {
        "L1": {
            "node_id": "L1",
            "rounds": 2,
            "data_outputs": {"B": {"text": "final opinion from B", "agent_id": "agent-b"}},
        }
    }

    assert _dependency_outputs_for_node(ctx, completed, ["L1"]) == {
        "B": {"text": "final opinion from B", "agent_id": "agent-b"}
    }
    assert _dependency_output_aliases_for_node(ctx, completed, ["L1"]) == {"L1": ["B"]}


def test_loop_feedback_uses_exit_child_not_loop_container():
    outputs_this_round = {
        "A": {"text": "draft"},
        "B": {"text": "final"},
    }

    assert _select_loop_feedback(outputs_this_round, [], ["B"]) == {"B": {"text": "final"}}


def test_loop_feedback_flattens_nested_loop_exit_output():
    outputs_this_round = {
        "InnerLoop": {
            "node_id": "InnerLoop",
            "data_outputs": {"C": {"text": "nested final"}},
        }
    }

    assert _select_loop_feedback(outputs_this_round, [], ["InnerLoop"]) == {
        "C": {"text": "nested final"}
    }


@pytest.mark.asyncio
async def test_output_node_source_filter_treats_loop_id_as_exit_child_alias():
    orchestrator = WorkflowOrchestrator.__new__(WorkflowOrchestrator)
    node = NodeContext(
        node_id="out1",
        node_type="output",
        config={"format": "text", "source_node_ids": ["L1"]},
        inputs={
            "dependency_outputs": {"B": {"text": "final opinion from B"}},
            "dependency_output_aliases": {"L1": ["B"]},
        },
    )
    ctx = SimpleNamespace(nodes={"out1": node})

    output = await orchestrator._execute_output_node(ctx, "out1")

    assert output["sources"] == ["B"]
    assert output["text"] == "[B]\nfinal opinion from B"


@pytest.mark.asyncio
async def test_output_node_json_uses_loop_exit_child_when_source_is_loop_id():
    orchestrator = WorkflowOrchestrator.__new__(WorkflowOrchestrator)
    node = NodeContext(
        node_id="out1",
        node_type="output",
        config={"format": "json", "source_node_ids": ["L1"]},
        inputs={
            "dependency_outputs": {"judge": {"outputs": {"decision": "CONTINUE"}}},
            "dependency_output_aliases": {"L1": ["judge"]},
        },
    )
    ctx = SimpleNamespace(nodes={"out1": node})

    output = await orchestrator._execute_output_node(ctx, "out1")

    assert output["sources"] == ["judge"]
    assert output["outputs"] == {"decision": "CONTINUE"}


@pytest.mark.asyncio
async def test_graph_scheduler_feeds_post_loop_agent_from_exit_child():
    orchestrator = WorkflowOrchestrator.__new__(WorkflowOrchestrator)
    graph = {
        "nodes": [
            {"id": "input1", "type": "input", "config": {"_ui": {}}},
            {"id": "L1", "type": "loop", "config": {"rounds": 1, "_ui": {}}},
            {"id": "A", "type": "agent", "config": {"_ui": {"parent_id": "L1"}}},
            {"id": "B", "type": "agent", "config": {"_ui": {"parent_id": "L1"}}},
            {"id": "after", "type": "agent", "config": {"_ui": {}}},
        ],
        "edges": [
            {"source": "input1", "target": "L1"},
            {"source": "L1", "target": "A", "source_handle": "loop-in-source"},
            {"source": "A", "target": "B"},
            {"source": "B", "target": "L1", "target_handle": "loop-out-target"},
            {"source": "L1", "target": "after"},
        ],
    }
    ctx = SimpleNamespace(
        workflow_def=SimpleNamespace(graph=graph),
        target_text="seed",
        user_instruction="start",
        context_files=[],
        nodes={
            node["id"]: NodeContext(
                node_id=node["id"],
                node_type=node["type"],
                config=node.get("config", {}),
            )
            for node in graph["nodes"]
        },
        all_outputs=[],
        chat_log=[],
    )

    async def fake_execute_agent_node(self, ctx, node_id):
        node = ctx.nodes[node_id]
        if node_id == "after":
            sources = ",".join(node.inputs["dependency_outputs"].keys())
            output = {"text": f"after saw {sources}"}
        else:
            output = {"text": f"{node_id} output"}
        node.outputs = output
        node.status = "completed"
        return output

    orchestrator._execute_agent_node = MethodType(fake_execute_agent_node, orchestrator)

    events = [event async for event in orchestrator._execute_graph(ctx)]

    assert ctx.nodes["after"].inputs["dependency_outputs"] == {"B": {"text": "B output"}}
    assert ctx.nodes["after"].outputs == {"text": "after saw B"}
    assert any(
        event["event"] == "node.completed"
        and event["data"].get("node_id") == "after"
        and event["data"].get("output", {}).get("text") == "after saw B"
        for event in events
    )

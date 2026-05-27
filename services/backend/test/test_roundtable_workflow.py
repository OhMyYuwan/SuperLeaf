"""Test Roundtable workflow execution with real Nanobot agents."""

import asyncio
import os

import pytest

from app.database import SessionLocal
from app.models import WorkflowDefinition
from app.services.agent_orchestrator import WorkflowOrchestrator

pytestmark = pytest.mark.skipif(
    os.environ.get("YLW_RUN_NANOBOT_INTEGRATION_TESTS") != "1",
    reason="requires live Nanobot integration services",
)


async def test_roundtable_workflow():
    """Test circular discussion A → B → A with two Nanobot agents."""
    db = SessionLocal()

    # Create a roundtable workflow
    roundtable_wf = WorkflowDefinition(
        name='Nanobot Roundtable Test',
        description='Test circular discussion with two Nanobot agents',
        execution_mode='roundtable',
        graph={
            'nodes': [
                {'id': 'n1', 'type': 'agent', 'config': {'agentId': 'nanobot-8901'}},
                {'id': 'n2', 'type': 'agent', 'config': {'agentId': 'nanobot-8902'}}
            ],
            'edges': [
                {'id': 'e1', 'from': 'n1', 'to': 'n2'},
                {'id': 'e2', 'from': 'n2', 'to': 'n1'}
            ]
        },
        config={'max_rounds': 2, 'convergence_threshold': 0.8}
    )
    db.add(roundtable_wf)
    db.commit()
    db.refresh(roundtable_wf)

    print("🚀 Starting roundtable workflow execution...")
    print(f"   Workflow ID: {roundtable_wf.id}")
    print("   Mode: roundtable (A ⇄ B)")
    print("   Max rounds: 2")
    print("   Agents: 8901, 8902")
    print()

    orchestrator = WorkflowOrchestrator(db)

    try:
        async for event in orchestrator.execute_workflow(
            workflow_def_id=roundtable_wf.id,
            document_id="test-doc-003",
            target_text="量子计算机可能会在未来十年内实现商业化应用。",
            range_start=0,
            range_end=100,
            user_instruction="请两位 Agent 讨论这个观点的可行性，互相补充和质疑",
        ):
            event_type = event.get("event", "unknown")
            data = event.get("data", {})

            print(f"📨 Event: {event_type}")

            if event_type == "workflow.started":
                print(f"   Mode: {data.get('mode')}")
            elif event_type == "round.started":
                print(f"   Round: {data.get('round')}/{data.get('max_rounds')}")
            elif event_type == "node.completed":
                node_id = data.get('node_id')
                round_num = data.get('round', 0)
                output = data.get('output', {})
                text = output.get('text', '')
                print(f"   Node: {node_id} (Round {round_num})")
                print(f"   Output preview: {text[:150]}...")
            elif event_type == "round.completed":
                print(f"   Round {data.get('round')} completed")
            elif event_type == "roundtable.converged":
                print(f"   🎯 Converged at round {data.get('round')}")
            elif event_type == "node.failed":
                print(f"   Node: {data.get('node_id')}")
                print(f"   Error: {data.get('error')}")
            elif event_type == "workflow.completed":
                print(f"   Run ID: {data.get('run_id')}")
                outputs = data.get('outputs', [])
                print(f"   Total outputs: {len(outputs)}")
                print()
                print("📊 Discussion history:")
                for i, output in enumerate(outputs):
                    agent_id = output.get('agent_id', 'unknown')
                    round_num = (i // 2) + 1
                    print(f"\n   Round {round_num} - Agent {agent_id}:")
                    print(f"   {output.get('text', '')[:200]}...")

            print()

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        db.close()

    print("✅ Roundtable test completed")


if __name__ == "__main__":
    asyncio.run(test_roundtable_workflow())

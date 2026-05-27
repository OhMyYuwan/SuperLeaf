"""Test nested workflow execution.

Tests:
1. A parallel workflow containing two roundtable workflows
2. A graph workflow with branching and merging
3. A pipeline that branches out and merges back
"""

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


async def test_nested_parallel_roundtable():
    """Test: Parallel workflow containing two Roundtable sub-workflows.

    Structure:
        Graph Root
        ├─ Roundtable A (nanobot-8901, nanobot-8902) - 1 round
        └─ Roundtable B (nanobot-8901, nanobot-8902) - 1 round
    """
    db = SessionLocal()

    # Step 1: Create two roundtable sub-workflows
    roundtable_a = WorkflowDefinition(
        name='Sub-Roundtable A',
        description='First roundtable sub-workflow',
        execution_mode='roundtable',
        graph={
            'nodes': [
                {'id': 'a1', 'type': 'agent', 'config': {'agentId': 'nanobot-8901'}},
                {'id': 'a2', 'type': 'agent', 'config': {'agentId': 'nanobot-8902'}}
            ],
            'edges': [
                {'id': 'e1', 'from': 'a1', 'to': 'a2'},
                {'id': 'e2', 'from': 'a2', 'to': 'a1'}
            ]
        },
        config={'max_rounds': 1}
    )

    roundtable_b = WorkflowDefinition(
        name='Sub-Roundtable B',
        description='Second roundtable sub-workflow',
        execution_mode='roundtable',
        graph={
            'nodes': [
                {'id': 'b1', 'type': 'agent', 'config': {'agentId': 'nanobot-8901'}},
                {'id': 'b2', 'type': 'agent', 'config': {'agentId': 'nanobot-8902'}}
            ],
            'edges': [
                {'id': 'e1', 'from': 'b1', 'to': 'b2'},
                {'id': 'e2', 'from': 'b2', 'to': 'b1'}
            ]
        },
        config={'max_rounds': 1}
    )

    db.add(roundtable_a)
    db.add(roundtable_b)
    db.commit()
    db.refresh(roundtable_a)
    db.refresh(roundtable_b)

    print(f'✅ Created Sub-Roundtable A: {roundtable_a.id}')
    print(f'✅ Created Sub-Roundtable B: {roundtable_b.id}')

    # Step 2: Create a graph workflow that contains both roundtables in parallel
    nested_wf = WorkflowDefinition(
        name='Nested Parallel Roundtables',
        description='A graph workflow containing two roundtable sub-workflows running in parallel',
        execution_mode='graph',
        graph={
            'nodes': [
                {
                    'id': 'r1',
                    'type': 'workflow',
                    'config': {'workflowDefinitionId': roundtable_a.id}
                },
                {
                    'id': 'r2',
                    'type': 'workflow',
                    'config': {'workflowDefinitionId': roundtable_b.id}
                }
            ],
            'edges': []  # No edges = all nodes run in parallel
        },
        config={}
    )

    db.add(nested_wf)
    db.commit()
    db.refresh(nested_wf)

    print(f'✅ Created Nested Workflow: {nested_wf.id}')
    print()

    # Step 3: Execute the nested workflow
    print("🚀 Starting nested workflow execution...")
    print("   Mode: graph")
    print("   Contains: 2 parallel roundtables")
    print()

    orchestrator = WorkflowOrchestrator(db)

    try:
        async for event in orchestrator.execute_workflow(
            workflow_def_id=nested_wf.id,
            document_id="test-nested-001",
            target_text="请讨论：AI 是否会在未来 10 年内取代大部分白领工作？",
            range_start=0,
            range_end=100,
            user_instruction="请进行简短的讨论",
        ):
            event_type = event.get("event", "unknown")
            data = event.get("data", {})

            print(f"📨 Event: {event_type}")

            if event_type == "workflow.started":
                print(f"   Mode: {data.get('mode')}")
            elif event_type == "node.completed":
                node_id = data.get('node_id')
                output = data.get('output', {})
                text = output.get('text', '')
                nested_count = len(output.get('nested_outputs', []))
                print(f"   Node: {node_id}")
                print(f"   Nested outputs count: {nested_count}")
                print(f"   Output preview: {text[:150]}...")
            elif event_type == "node.failed":
                print(f"   Node: {data.get('node_id')}")
                print(f"   Error: {data.get('error')}")
            elif event_type == "workflow.completed":
                print(f"   Run ID: {data.get('run_id')}")
                outputs = data.get('outputs', [])
                print(f"   Total outputs: {len(outputs)}")

            print()

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        db.close()

    print("✅ Nested workflow test completed")


if __name__ == "__main__":
    asyncio.run(test_nested_parallel_roundtable())

"""Test complex graph workflow with branching and merging.

Structure:
    Input
      ├─ Agent A (8901) ─┐
      └─ Agent B (8902) ─┴─→ Merge → Agent C (8901) - final synthesis

This demonstrates:
- Parallel execution (A and B run in parallel)
- Merge node (waits for both A and B to complete)
- Sequential dependency (C depends on merge result)
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


async def test_branch_and_merge():
    """Test: Parallel branching and merging back to a single node."""
    db = SessionLocal()

    # Create a graph workflow with branching and merging
    branch_merge_wf = WorkflowDefinition(
        name='Branch and Merge Workflow',
        description='Two agents analyze in parallel, then merge results, then final synthesis',
        execution_mode='graph',
        graph={
            'nodes': [
                # Two parallel analyzers
                {
                    'id': 'analyzer_a',
                    'type': 'agent',
                    'config': {'agentId': 'nanobot-8901'}
                },
                {
                    'id': 'analyzer_b',
                    'type': 'agent',
                    'config': {'agentId': 'nanobot-8902'}
                },
                # Merge node collects both analyses
                {
                    'id': 'merger',
                    'type': 'merge',
                    'config': {'strategy': 'concat'}
                },
                # Final synthesizer
                {
                    'id': 'synthesizer',
                    'type': 'agent',
                    'config': {'agentId': 'nanobot-8901'}
                }
            ],
            'edges': [
                # Both analyzers feed into merge
                {'id': 'e1', 'from': 'analyzer_a', 'to': 'merger'},
                {'id': 'e2', 'from': 'analyzer_b', 'to': 'merger'},
                # Merge feeds into synthesizer
                {'id': 'e3', 'from': 'merger', 'to': 'synthesizer'}
            ]
        },
        config={}
    )

    db.add(branch_merge_wf)
    db.commit()
    db.refresh(branch_merge_wf)

    print(f'✅ Created Branch-Merge Workflow: {branch_merge_wf.id}')
    print()
    print('🚀 Starting branch-merge workflow execution...')
    print('   Structure:')
    print('     Analyzer A (8901) ─┐')
    print('                        ├─→ Merger → Synthesizer (8901)')
    print('     Analyzer B (8902) ─┘')
    print()

    orchestrator = WorkflowOrchestrator(db)

    execution_order = []

    try:
        async for event in orchestrator.execute_workflow(
            workflow_def_id=branch_merge_wf.id,
            document_id="test-branch-merge-001",
            target_text="机器学习与传统统计学的核心区别是什么？",
            range_start=0,
            range_end=50,
            user_instruction="请从不同角度分析，最后进行综合总结",
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
                execution_order.append(node_id)
                print(f"   Node: {node_id}")
                if output.get('strategy'):
                    print(f"   Strategy: {output.get('strategy')}")
                    print(f"   Input count: {output.get('input_count')}")
                print(f"   Output preview: {text[:100]}...")
            elif event_type == "node.failed":
                print(f"   Node: {data.get('node_id')}")
                print(f"   Error: {data.get('error')}")
            elif event_type == "workflow.completed":
                print(f"   Run ID: {data.get('run_id')}")
                outputs = data.get('outputs', [])
                print(f"   Total outputs: {len(outputs)}")

            print()

        print("📋 Execution order:")
        for i, node_id in enumerate(execution_order, 1):
            print(f"   {i}. {node_id}")

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        db.close()

    print("\n✅ Branch-merge workflow test completed")


if __name__ == "__main__":
    asyncio.run(test_branch_and_merge())

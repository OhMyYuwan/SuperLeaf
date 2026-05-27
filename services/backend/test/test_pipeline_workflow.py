"""Test Pipeline workflow execution with real Nanobot agents."""

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


async def test_pipeline_workflow():
    """Test sequential execution A → B with two Nanobot agents."""
    db = SessionLocal()

    # Create a pipeline workflow
    pipeline_wf = WorkflowDefinition(
        name='Nanobot Pipeline Test',
        description='Test sequential execution with two Nanobot agents',
        execution_mode='pipeline',
        graph={
            'nodes': [
                {'id': 'n1', 'type': 'agent', 'config': {'agentId': 'nanobot-8901'}},
                {'id': 'n2', 'type': 'agent', 'config': {'agentId': 'nanobot-8902'}}
            ],
            'edges': [
                {'id': 'e1', 'from': 'n1', 'to': 'n2'}
            ]
        },
        config={}
    )
    db.add(pipeline_wf)
    db.commit()
    db.refresh(pipeline_wf)

    print("🚀 Starting pipeline workflow execution...")
    print(f"   Workflow ID: {pipeline_wf.id}")
    print("   Mode: pipeline (A → B)")
    print("   Agent 1 (8901) → Agent 2 (8902)")
    print()

    orchestrator = WorkflowOrchestrator(db)

    try:
        async for event in orchestrator.execute_workflow(
            workflow_def_id=pipeline_wf.id,
            document_id="test-doc-002",
            target_text="人工智能技术正在快速发展，特别是大语言模型的出现改变了很多行业。",
            range_start=0,
            range_end=100,
            user_instruction="第一个 Agent 请分析这段话的主题，第二个 Agent 请基于第一个的分析提出改进建议",
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
                print(f"   Node: {node_id}")
                print(f"   Output preview: {text[:150]}...")
                print()
            elif event_type == "node.failed":
                print(f"   Node: {data.get('node_id')}")
                print(f"   Error: {data.get('error')}")
            elif event_type == "workflow.completed":
                print(f"   Run ID: {data.get('run_id')}")
                outputs = data.get('outputs', [])
                print(f"   Total outputs: {len(outputs)}")
                print()
                print("📊 Final outputs:")
                for i, output in enumerate(outputs):
                    print(f"\n   Agent {i+1} output:")
                    print(f"   {output.get('text', '')[:200]}...")

            print()

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        db.close()

    print("✅ Pipeline test completed")


if __name__ == "__main__":
    asyncio.run(test_pipeline_workflow())

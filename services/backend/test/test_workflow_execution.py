"""Test workflow execution with real Nanobot agents."""

import asyncio
import os

import pytest

from app.database import SessionLocal
from app.services.agent_orchestrator import WorkflowOrchestrator

pytestmark = pytest.mark.skipif(
    os.environ.get("YLW_RUN_NANOBOT_INTEGRATION_TESTS") != "1",
    reason="requires live Nanobot integration services",
)


async def test_parallel_workflow():
    """Test parallel execution with two Nanobot agents."""
    db = SessionLocal()
    orchestrator = WorkflowOrchestrator(db)

    workflow_id = "05bfc6cf26104d619eb7b83622135d99"

    print("🚀 Starting parallel workflow execution...")
    print(f"   Workflow ID: {workflow_id}")
    print("   Agents: nanobot-8901 (port 8901), nanobot-8902 (port 8902)")
    print()

    try:
        async for event in orchestrator.execute_workflow(
            workflow_def_id=workflow_id,
            document_id="test-doc-001",
            target_text="这是一个测试文本。我们正在测试 workflow 编排功能，看看两个 Agent 能否并行工作。",
            range_start=0,
            range_end=100,
            user_instruction="请分析这段文本的优缺点",
        ):
            event_type = event.get("event", "unknown")
            data = event.get("data", {})

            print(f"📨 Event: {event_type}")

            if event_type == "workflow.started":
                print(f"   Mode: {data.get('mode')}")
            elif event_type == "node.completed":
                print(f"   Node: {data.get('node_id')}")
                output = data.get('output', {})
                text = output.get('text', '')
                print(f"   Output: {text[:100]}..." if len(text) > 100 else f"   Output: {text}")
            elif event_type == "node.failed":
                print(f"   Node: {data.get('node_id')}")
                print(f"   Error: {data.get('error')}")
            elif event_type == "workflow.merged":
                print(f"   Strategy: {data.get('strategy')}")
                print(f"   Count: {data.get('count')}")
            elif event_type == "workflow.completed":
                print(f"   Run ID: {data.get('run_id')}")
                print(f"   Total outputs: {len(data.get('outputs', []))}")

            print()

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        db.close()

    print("✅ Test completed")


if __name__ == "__main__":
    asyncio.run(test_parallel_workflow())

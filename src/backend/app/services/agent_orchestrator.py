"""Workflow orchestrator for multi-agent execution.

Supports four execution modes:
1. Parallel: Multiple agents process the same input simultaneously
2. Pipeline: Sequential A → B → C execution
3. Roundtable: Circular A → B → C → A discussion with convergence detection
4. Graph: General-purpose DAG execution with support for:
   - Nested workflows (workflow nodes)
   - Conditional branching (judge nodes)
   - Multi-input merging (merge nodes)
   - Loop control (loop nodes)
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..models import CachedWorkflow, Provider, WorkflowDefinition, WorkflowRun
from .dify_client import DifyClient
from .nanobot_client import NanobotClient
from .provider_service import ProviderService


@dataclass
class NodeContext:
    """Execution context for a single node."""
    node_id: str
    node_type: str
    config: dict
    inputs: dict = field(default_factory=dict)
    outputs: dict = field(default_factory=dict)
    status: str = "pending"  # pending | running | completed | failed
    error: str = ""
    started_at: datetime | None = None
    finished_at: datetime | None = None


@dataclass
class OrchestrationContext:
    """Global context for workflow execution."""
    workflow_def: WorkflowDefinition
    workflow_run: WorkflowRun
    document_id: str
    target_text: str
    target_range: dict
    user_instruction: str
    db: Session
    # Node execution contexts
    nodes: dict[str, NodeContext] = field(default_factory=dict)
    # Accumulated outputs from all agents
    all_outputs: list[dict] = field(default_factory=list)
    # Current round (for roundtable mode)
    current_round: int = 0


class WorkflowOrchestrator:
    """Orchestrates multi-agent workflow execution."""

    def __init__(self, db: Session):
        self.db = db
        self.provider_service = ProviderService(db)

    async def execute_workflow(
        self,
        *,
        workflow_def_id: str,
        document_id: str,
        target_text: str,
        range_start: int,
        range_end: int,
        user_instruction: str = "",
    ) -> AsyncIterator[dict]:
        """Execute a workflow definition and stream events."""
        # Load workflow definition
        workflow_def = self.db.get(WorkflowDefinition, workflow_def_id)
        if not workflow_def:
            raise ValueError(f"Workflow definition {workflow_def_id} not found")

        # Create workflow run record
        workflow_run = WorkflowRun(
            provider_id="",  # Will be set per agent
            workflow_id="",  # Not a single-agent run
            workflow_definition_id=workflow_def_id,
            document_id=document_id,
            range_start=range_start,
            range_end=range_end,
            status="running",
            max_rounds=workflow_def.config.get("max_rounds", 3),
        )
        self.db.add(workflow_run)
        self.db.commit()
        self.db.refresh(workflow_run)

        # Build orchestration context
        ctx = OrchestrationContext(
            workflow_def=workflow_def,
            workflow_run=workflow_run,
            document_id=document_id,
            target_text=target_text,
            target_range={"from": range_start, "to": range_end},
            user_instruction=user_instruction,
            db=self.db,
        )

        # Initialize node contexts
        for node in workflow_def.graph.get("nodes", []):
            ctx.nodes[node["id"]] = NodeContext(
                node_id=node["id"],
                node_type=node["type"],
                config=node.get("config", {}),
            )

        # Execute based on mode
        try:
            if workflow_def.execution_mode == "parallel":
                async for event in self._execute_parallel(ctx):
                    yield event
            elif workflow_def.execution_mode == "pipeline":
                async for event in self._execute_pipeline(ctx):
                    yield event
            elif workflow_def.execution_mode == "roundtable":
                async for event in self._execute_roundtable(ctx):
                    yield event
            elif workflow_def.execution_mode == "graph":
                async for event in self._execute_graph(ctx):
                    yield event
            else:
                raise ValueError(f"Unknown execution mode: {workflow_def.execution_mode}")

            # Mark as completed
            workflow_run.status = "completed"
            workflow_run.finished_at = datetime.utcnow()
            self.db.commit()

            yield {
                "event": "workflow.completed",
                "data": {
                    "run_id": workflow_run.id,
                    "outputs": ctx.all_outputs,
                },
            }

        except Exception as e:
            workflow_run.status = "failed"
            workflow_run.error = str(e)
            workflow_run.finished_at = datetime.utcnow()
            self.db.commit()
            raise

    async def _execute_parallel(self, ctx: OrchestrationContext) -> AsyncIterator[dict]:
        """Execute agents in parallel and merge results."""
        yield {"event": "workflow.started", "data": {"mode": "parallel"}}

        # Find all agent nodes
        agent_nodes = [
            node for node in ctx.workflow_def.graph.get("nodes", [])
            if node["type"] == "agent"
        ]

        if not agent_nodes:
            raise ValueError("No agent nodes found in parallel workflow")

        # Execute all agents in parallel
        tasks = []
        for node in agent_nodes:
            task = self._execute_agent_node(ctx, node["id"])
            tasks.append(task)

        # Wait for all to complete
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Collect outputs
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                yield {
                    "event": "node.failed",
                    "data": {
                        "node_id": agent_nodes[i]["id"],
                        "error": str(result),
                    },
                }
            else:
                ctx.all_outputs.append(result)
                yield {
                    "event": "node.completed",
                    "data": {
                        "node_id": agent_nodes[i]["id"],
                        "output": result,
                    },
                }

        # Merge results
        merged = self._merge_outputs(ctx.all_outputs, strategy="concat")
        yield {"event": "workflow.merged", "data": merged}

    async def _execute_pipeline(self, ctx: OrchestrationContext) -> AsyncIterator[dict]:
        """Execute agents sequentially A → B → C."""
        yield {"event": "workflow.started", "data": {"mode": "pipeline"}}

        # Build execution order from edges
        nodes = ctx.workflow_def.graph.get("nodes", [])
        edges = ctx.workflow_def.graph.get("edges", [])

        # Simple topological sort (assumes DAG)
        execution_order = self._topological_sort(nodes, edges)

        # Execute nodes in order
        previous_output = None
        for node_id in execution_order:
            node = ctx.nodes[node_id]

            if node.node_type == "agent":
                # Pass previous output as context
                if previous_output:
                    node.inputs["previous_output"] = previous_output

                output = await self._execute_agent_node(ctx, node_id)
                previous_output = output
                ctx.all_outputs.append(output)

                yield {
                    "event": "node.completed",
                    "data": {"node_id": node_id, "output": output},
                }

    async def _execute_roundtable(self, ctx: OrchestrationContext) -> AsyncIterator[dict]:
        """Execute agents in circular discussion A → B → C → A."""
        yield {"event": "workflow.started", "data": {"mode": "roundtable"}}

        agent_nodes = [
            node for node in ctx.workflow_def.graph.get("nodes", [])
            if node["type"] == "agent"
        ]

        if len(agent_nodes) < 2:
            raise ValueError("Roundtable requires at least 2 agents")

        max_rounds = ctx.workflow_run.max_rounds
        convergence_threshold = ctx.workflow_def.config.get("convergence_threshold", 0.8)

        for round_num in range(1, max_rounds + 1):
            ctx.current_round = round_num
            ctx.workflow_run.current_round = round_num
            self.db.commit()

            yield {
                "event": "round.started",
                "data": {"round": round_num, "max_rounds": max_rounds},
            }

            round_outputs = []

            # Execute each agent in sequence
            for node in agent_nodes:
                # Pass all previous outputs as context
                ctx.nodes[node["id"]].inputs["previous_outputs"] = ctx.all_outputs
                ctx.nodes[node["id"]].inputs["current_round"] = round_num

                output = await self._execute_agent_node(ctx, node["id"])
                round_outputs.append(output)
                ctx.all_outputs.append(output)

                yield {
                    "event": "node.completed",
                    "data": {
                        "node_id": node["id"],
                        "round": round_num,
                        "output": output,
                    },
                }

            # Check convergence
            if round_num > 1:
                converged = self._check_convergence(round_outputs, convergence_threshold)
                if converged:
                    yield {
                        "event": "roundtable.converged",
                        "data": {"round": round_num, "outputs": round_outputs},
                    }
                    break

            yield {"event": "round.completed", "data": {"round": round_num}}

    async def _execute_graph(self, ctx: OrchestrationContext) -> AsyncIterator[dict]:
        """Execute workflow as a general DAG with support for complex structures."""
        yield {"event": "workflow.started", "data": {"mode": "graph"}}

        nodes = ctx.workflow_def.graph.get("nodes", [])
        edges = ctx.workflow_def.graph.get("edges", [])

        # Build dependency graph
        dependencies = {node["id"]: [] for node in nodes}
        dependents = {node["id"]: [] for node in nodes}
        in_degree = {node["id"]: 0 for node in nodes}

        for edge in edges:
            from_node = edge["from"]
            to_node = edge["to"]
            dependencies[to_node].append(from_node)
            dependents[from_node].append(to_node)
            in_degree[to_node] += 1

        # Track completed nodes and their outputs
        completed = {}
        pending_tasks = {}

        # Start with nodes that have no dependencies
        ready_nodes = [node_id for node_id, degree in in_degree.items() if degree == 0]

        while ready_nodes or pending_tasks:
            # Start all ready nodes in parallel
            if ready_nodes:
                for node_id in ready_nodes:
                    node = ctx.nodes[node_id]
                    # Collect inputs from dependencies
                    node.inputs["dependency_outputs"] = {
                        dep_id: completed[dep_id] for dep_id in dependencies[node_id]
                    }
                    # Start execution
                    task = asyncio.create_task(self._execute_node(ctx, node_id))
                    pending_tasks[node_id] = task

                ready_nodes = []

            # Wait for at least one task to complete
            if pending_tasks:
                done, pending = await asyncio.wait(
                    pending_tasks.values(),
                    return_when=asyncio.FIRST_COMPLETED
                )

                # Process completed tasks
                for task in done:
                    # Find which node completed
                    completed_node_id = None
                    for node_id, t in pending_tasks.items():
                        if t == task:
                            completed_node_id = node_id
                            break

                    if completed_node_id:
                        try:
                            output = await task
                            completed[completed_node_id] = output
                            ctx.all_outputs.append(output)

                            yield {
                                "event": "node.completed",
                                "data": {
                                    "node_id": completed_node_id,
                                    "output": output,
                                },
                            }

                            # Check if any dependent nodes are now ready
                            for dependent_id in dependents[completed_node_id]:
                                in_degree[dependent_id] -= 1
                                if in_degree[dependent_id] == 0:
                                    # All dependencies satisfied
                                    ready_nodes.append(dependent_id)

                        except Exception as e:
                            yield {
                                "event": "node.failed",
                                "data": {
                                    "node_id": completed_node_id,
                                    "error": str(e),
                                },
                            }

                        # Remove from pending
                        del pending_tasks[completed_node_id]

    async def _execute_node(self, ctx: OrchestrationContext, node_id: str) -> dict:
        """Execute a single node (agent, workflow, merge, judge, etc.)."""
        node = ctx.nodes[node_id]

        if node.node_type == "agent":
            return await self._execute_agent_node(ctx, node_id)
        elif node.node_type == "workflow":
            return await self._execute_workflow_node(ctx, node_id)
        elif node.node_type == "merge":
            return await self._execute_merge_node(ctx, node_id)
        elif node.node_type == "judge":
            return await self._execute_judge_node(ctx, node_id)
        elif node.node_type == "loop":
            return await self._execute_loop_node(ctx, node_id)
        else:
            raise ValueError(f"Unknown node type: {node.node_type}")

    async def _execute_workflow_node(self, ctx: OrchestrationContext, node_id: str) -> dict:
        """Execute a nested workflow node."""
        node = ctx.nodes[node_id]
        node.status = "running"
        node.started_at = datetime.utcnow()

        try:
            # Get nested workflow definition ID
            nested_workflow_id = node.config.get("workflowDefinitionId")
            if not nested_workflow_id:
                raise ValueError(f"Workflow node {node_id} missing workflowDefinitionId")

            # Create a new orchestrator for the nested workflow
            nested_orchestrator = WorkflowOrchestrator(self.db)

            # Collect outputs from nested workflow
            nested_outputs = []
            async for event in nested_orchestrator.execute_workflow(
                workflow_def_id=nested_workflow_id,
                document_id=ctx.document_id,
                target_text=ctx.target_text,
                range_start=ctx.target_range["from"],
                range_end=ctx.target_range["to"],
                user_instruction=ctx.user_instruction,
            ):
                # Forward nested events with prefix
                event["event"] = f"nested.{event['event']}"
                event["data"]["parent_node_id"] = node_id
                # Note: We don't yield here to avoid mixing event streams
                # In production, you might want to yield these events

                if event["event"] == "nested.workflow.completed":
                    nested_outputs = event["data"].get("outputs", [])

            # Merge nested outputs
            output = {
                "text": "\n\n".join(out.get("text", "") for out in nested_outputs),
                "nested_outputs": nested_outputs,
                "node_id": node_id,
            }

            node.outputs = output
            node.status = "completed"
            node.finished_at = datetime.utcnow()

            # Add to trace
            ctx.workflow_run.trace.append({
                "node_id": node_id,
                "node_type": "workflow",
                "nested_workflow_id": nested_workflow_id,
                "started_at": node.started_at.isoformat(),
                "finished_at": node.finished_at.isoformat(),
                "status": "completed",
                "output": output,
            })
            self.db.commit()

            return output

        except Exception as e:
            node.status = "failed"
            node.error = str(e)
            node.finished_at = datetime.utcnow()

            ctx.workflow_run.trace.append({
                "node_id": node_id,
                "node_type": "workflow",
                "started_at": node.started_at.isoformat() if node.started_at else None,
                "finished_at": node.finished_at.isoformat(),
                "status": "failed",
                "error": str(e),
            })
            self.db.commit()
            raise

    async def _execute_merge_node(self, ctx: OrchestrationContext, node_id: str) -> dict:
        """Execute a merge node that combines multiple inputs."""
        node = ctx.nodes[node_id]
        node.status = "running"
        node.started_at = datetime.utcnow()

        try:
            # Get inputs from dependencies
            dependency_outputs = node.inputs.get("dependency_outputs", {})
            strategy = node.config.get("strategy", "concat")

            # Merge outputs based on strategy
            merged = self._merge_outputs(list(dependency_outputs.values()), strategy)

            output = {
                "text": merged.get("text", ""),
                "strategy": strategy,
                "input_count": len(dependency_outputs),
                "node_id": node_id,
            }

            node.outputs = output
            node.status = "completed"
            node.finished_at = datetime.utcnow()

            return output

        except Exception as e:
            node.status = "failed"
            node.error = str(e)
            node.finished_at = datetime.utcnow()
            raise

    async def _execute_judge_node(self, ctx: OrchestrationContext, node_id: str) -> dict:
        """Execute a judge node that makes conditional decisions."""
        node = ctx.nodes[node_id]
        node.status = "running"
        node.started_at = datetime.utcnow()

        try:
            # Get inputs from dependencies
            dependency_outputs = node.inputs.get("dependency_outputs", {})
            condition = node.config.get("condition", {})

            # Evaluate condition (simple implementation)
            # In production, you'd want a more sophisticated condition evaluator
            field = condition.get("field", "")
            operator = condition.get("operator", "==")
            value = condition.get("value")

            # Extract field value from inputs
            # For now, just check if any output contains the field
            result = False
            for dep_output in dependency_outputs.values():
                if field in dep_output:
                    field_value = dep_output[field]
                    if operator == "==":
                        result = field_value == value
                    elif operator == ">":
                        result = field_value > value
                    elif operator == "<":
                        result = field_value < value
                    # Add more operators as needed
                    break

            output = {
                "decision": result,
                "condition": condition,
                "node_id": node_id,
            }

            node.outputs = output
            node.status = "completed"
            node.finished_at = datetime.utcnow()

            return output

        except Exception as e:
            node.status = "failed"
            node.error = str(e)
            node.finished_at = datetime.utcnow()
            raise

    async def _execute_loop_node(self, ctx: OrchestrationContext, node_id: str) -> dict:
        """Execute a loop node that controls iteration."""
        node = ctx.nodes[node_id]
        node.status = "running"
        node.started_at = datetime.utcnow()

        try:
            # Get loop configuration
            max_iterations = node.config.get("max_iterations", 3)
            current_iteration = node.inputs.get("current_iteration", 0)

            # Check if we should continue looping
            should_continue = current_iteration < max_iterations

            output = {
                "should_continue": should_continue,
                "current_iteration": current_iteration,
                "max_iterations": max_iterations,
                "node_id": node_id,
            }

            node.outputs = output
            node.status = "completed"
            node.finished_at = datetime.utcnow()

            return output

        except Exception as e:
            node.status = "failed"
            node.error = str(e)
            node.finished_at = datetime.utcnow()
            raise

    async def _execute_agent_node(self, ctx: OrchestrationContext, node_id: str) -> dict:
        """Execute a single agent node and return its output."""
        node = ctx.nodes[node_id]
        node.status = "running"
        node.started_at = datetime.utcnow()

        try:
            # Get agent configuration
            agent_id = node.config.get("agentId") or node.config.get("agent_id")
            if not agent_id:
                raise ValueError(f"Node {node_id} missing agentId")

            # Load cached workflow (agent)
            cached_workflow = self.db.get(CachedWorkflow, agent_id)
            if not cached_workflow:
                raise ValueError(f"Agent {agent_id} not found")

            # Load provider
            provider = self.db.get(Provider, cached_workflow.provider_id)
            if not provider:
                raise ValueError(f"Provider {cached_workflow.provider_id} not found")

            # Build prompt with context
            prompt = self._build_agent_prompt(ctx, node)

            # Execute agent based on provider type
            client = self.provider_service.make_client(provider)

            if provider.kind.startswith("dify"):
                if not isinstance(client, DifyClient):
                    raise TypeError(f"Expected DifyClient for dify provider")

                # Collect streaming output
                accumulated_text = ""
                async for evt in client.run_streaming(
                    workflow_id=cached_workflow.external_id,
                    inputs={"query": prompt},
                    user="orchestrator",
                ):
                    if evt.get("event") == "text_chunk":
                        accumulated_text += evt.get("data", "")

                output = {"text": accumulated_text, "agent_id": agent_id}

            elif provider.kind == "nanobot":
                if not isinstance(client, NanobotClient):
                    raise TypeError(f"Expected NanobotClient for nanobot provider")

                # Collect streaming output
                accumulated_text = ""
                async for evt in client.run_streaming(
                    model=cached_workflow.external_id,
                    messages=[{"role": "user", "content": prompt}],
                    session_id=ctx.workflow_run.id,
                ):
                    delta = evt.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    accumulated_text += delta

                output = {"text": accumulated_text, "agent_id": agent_id}

            else:
                raise ValueError(f"Unsupported provider kind: {provider.kind}")

            node.outputs = output
            node.status = "completed"
            node.finished_at = datetime.utcnow()

            # Add to trace
            ctx.workflow_run.trace.append({
                "node_id": node_id,
                "agent_id": agent_id,
                "started_at": node.started_at.isoformat(),
                "finished_at": node.finished_at.isoformat(),
                "status": "completed",
                "input": node.inputs,
                "output": output,
            })
            self.db.commit()

            return output

        except Exception as e:
            node.status = "failed"
            node.error = str(e)
            node.finished_at = datetime.utcnow()

            ctx.workflow_run.trace.append({
                "node_id": node_id,
                "started_at": node.started_at.isoformat() if node.started_at else None,
                "finished_at": node.finished_at.isoformat(),
                "status": "failed",
                "error": str(e),
            })
            self.db.commit()
            raise

    def _build_agent_prompt(self, ctx: OrchestrationContext, node: NodeContext) -> str:
        """Build prompt for agent with context from previous outputs."""
        parts = []

        # User instruction
        if ctx.user_instruction:
            parts.append(f"User instruction: {ctx.user_instruction}")

        # Target text
        parts.append(f"\nTarget text:\n{ctx.target_text}")

        # Previous outputs (for pipeline/roundtable)
        if "previous_output" in node.inputs:
            prev = node.inputs["previous_output"]
            parts.append(f"\nPrevious agent output:\n{prev.get('text', '')}")

        if "previous_outputs" in node.inputs:
            parts.append("\nPrevious discussion:")
            for i, output in enumerate(node.inputs["previous_outputs"][-3:]):  # Last 3
                parts.append(f"\nAgent {i+1}: {output.get('text', '')[:200]}...")

        # Round info (for roundtable)
        if "current_round" in node.inputs:
            parts.append(f"\n[Round {node.inputs['current_round']} of {ctx.workflow_run.max_rounds}]")

        return "\n".join(parts)

    def _merge_outputs(self, outputs: list[dict], strategy: str = "concat") -> dict:
        """Merge multiple agent outputs based on strategy."""
        if strategy == "concat":
            merged_text = "\n\n---\n\n".join(
                f"Agent {i+1}:\n{out.get('text', '')}"
                for i, out in enumerate(outputs)
            )
            return {"text": merged_text, "strategy": "concat", "count": len(outputs)}

        # TODO: Implement other strategies (deduplicate, vote, priority)
        return {"text": "", "strategy": strategy, "count": len(outputs)}

    def _check_convergence(self, round_outputs: list[dict], threshold: float) -> bool:
        """Check if agents have converged (simple heuristic)."""
        # Simple heuristic: if outputs are similar enough, consider converged
        # TODO: Implement proper similarity check (e.g., embedding cosine similarity)
        if len(round_outputs) < 2:
            return False

        # For now, just check if all outputs are non-empty
        return all(len(out.get("text", "")) > 50 for out in round_outputs)

    def _topological_sort(self, nodes: list[dict], edges: list[dict]) -> list[str]:
        """Simple topological sort for pipeline execution order."""
        # Build adjacency list
        graph = {node["id"]: [] for node in nodes}
        in_degree = {node["id"]: 0 for node in nodes}

        for edge in edges:
            graph[edge["from"]].append(edge["to"])
            in_degree[edge["to"]] += 1

        # Find nodes with no incoming edges
        queue = [node_id for node_id, degree in in_degree.items() if degree == 0]
        result = []

        while queue:
            node_id = queue.pop(0)
            result.append(node_id)

            for neighbor in graph[node_id]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        if len(result) != len(nodes):
            raise ValueError("Workflow graph contains a cycle")

        return result


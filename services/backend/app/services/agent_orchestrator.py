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
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.orm import Session

from ..models import WorkflowDefinition, WorkflowRun
from ..secrets_vault import decrypt
from .agent_registry_service import AgentRegistryService
from .agent_workspace_service import AgentWorkspaceService
from .dify_client import DifyClient
from .mcp_config_service import McpConfigService
from .nanobot_client import NanobotClient
from .native_agent_runner import NativeAgentRunner, NativeAgentRuntimeConfig, NativeRunPayload
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
    # Files referenced via @-mentions in the run request. Each entry carries
    # at minimum { name, content }, and optionally { document_id }.
    context_files: list[dict] = field(default_factory=list)
    # Node execution contexts
    nodes: dict[str, NodeContext] = field(default_factory=dict)
    # Accumulated outputs from all agents
    all_outputs: list[dict] = field(default_factory=list)
    # Current round (for roundtable mode)
    current_round: int = 0
    # Chronological, run-local conversation history. This mirrors Dify's
    # query/answer thread projection, but only for one workflow run.
    chat_log: list[dict] = field(default_factory=list)


class WorkflowOrchestrator:
    """Orchestrates multi-agent workflow execution."""

    def __init__(self, db: Session):
        self.db = db
        self.provider_service = ProviderService(db)
        self.agent_registry = AgentRegistryService(db)

    async def execute_workflow(
        self,
        *,
        workflow_def_id: str,
        project_id: str,
        user_id: str = "",
        document_id: str,
        target_text: str,
        range_start: int,
        range_end: int,
        user_instruction: str = "",
        context_files: list[dict] | None = None,
    ) -> AsyncIterator[dict]:
        """Execute a workflow definition and stream events."""
        # Load workflow definition
        workflow_def = self.db.get(WorkflowDefinition, workflow_def_id)
        if not workflow_def:
            raise ValueError(f"Workflow definition {workflow_def_id} not found")

        # Create workflow run record
        workflow_run = WorkflowRun(
            project_id=project_id,
            user_id=user_id,
            provider_id="",  # Will be set per agent
            workflow_id="",  # Not a single-agent run
            workflow_definition_id=workflow_def_id,
            document_id=document_id,
            range_start=range_start,
            range_end=range_end,
            source_text=target_text,
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
            context_files=list(context_files or []),
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

            # When the graph has explicit `output` nodes, the final payload is
            # their aggregated result (parseDifyOutputs-compatible). When it
            # doesn't, fall back to the legacy behavior of shipping the raw
            # all_outputs list so existing parallel/pipeline/roundtable
            # workflows keep working.
            output_nodes = [
                nc for nc in ctx.nodes.values()
                if nc.node_type == "output" and nc.status == "completed"
            ]
            if output_nodes:
                if len(output_nodes) == 1:
                    final_outputs = output_nodes[0].outputs.get("outputs") or {
                        "text": output_nodes[0].outputs.get("text", ""),
                    }
                else:
                    final_outputs = {
                        nc.node_id: nc.outputs.get("outputs") or {"text": nc.outputs.get("text", "")}
                        for nc in output_nodes
                    }
            else:
                final_outputs = ctx.all_outputs

            yield {
                "event": "workflow.completed",
                "data": {
                    "run_id": workflow_run.id,
                    "outputs": final_outputs,
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
        _seed_chat_from_request(ctx)

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
            ctx.nodes[node["id"]].inputs["prior_messages"] = _chat_log_to_messages(ctx.chat_log)
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
                            "input": ctx.nodes[agent_nodes[i]["id"]].inputs,
                            "error": str(result),
                        },
                    }
            else:
                ctx.all_outputs.append(result)
                yield {
                    "event": "node.completed",
                        "data": {
                            "node_id": agent_nodes[i]["id"],
                            "input": ctx.nodes[agent_nodes[i]["id"]].inputs,
                            "output": result,
                        },
                    }

        # Merge results
        merged = self._merge_outputs(ctx.all_outputs, strategy="concat")
        yield {"event": "workflow.merged", "data": merged}

    async def _execute_pipeline(self, ctx: OrchestrationContext) -> AsyncIterator[dict]:
        """Execute agents sequentially A → B → C."""
        yield {"event": "workflow.started", "data": {"mode": "pipeline"}}
        _seed_chat_from_request(ctx)

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
                node.inputs["prior_messages"] = _chat_log_to_messages(ctx.chat_log)

                output = await self._execute_agent_node(ctx, node_id)
                previous_output = output
                ctx.all_outputs.append(output)

                yield {
                    "event": "node.completed",
                    "data": {
                        "node_id": node_id,
                        "input": node.inputs,
                        "output": output,
                    },
                }

    async def _execute_roundtable(self, ctx: OrchestrationContext) -> AsyncIterator[dict]:
        """Execute agents in circular discussion A → B → C → A."""
        yield {"event": "workflow.started", "data": {"mode": "roundtable"}}
        _seed_chat_from_request(ctx)

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
                ctx.nodes[node["id"]].inputs["prior_messages"] = _chat_log_to_messages(ctx.chat_log)

                output = await self._execute_agent_node(ctx, node["id"])
                round_outputs.append(output)
                ctx.all_outputs.append(output)

                yield {
                    "event": "node.completed",
                    "data": {
                        "node_id": node["id"],
                        "round": round_num,
                        "input": ctx.nodes[node["id"]].inputs,
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

        # Loop containers execute their children as a sub-graph for N rounds.
        # Filter them out of the top-level DAG — children are driven from inside
        # _execute_loop_node instead.
        loop_ids = {n["id"] for n in nodes if n.get("type") == "loop"}
        child_ids = {n["id"] for n in nodes if _parent_id(n) in loop_ids}
        top_nodes = [
            n for n in nodes
            if n.get("type") != "loop" and n["id"] not in child_ids
        ]
        top_node_ids = {n["id"] for n in top_nodes}
        # Also expose loop containers themselves as top-level nodes so they can
        # participate in the outer topology.
        for ln in nodes:
            if ln.get("type") == "loop" and not _parent_id(ln):
                top_nodes.append(ln)
                top_node_ids.add(ln["id"])

        top_edges = [
            e for e in edges
            if _edge_source(e) in top_node_ids and _edge_target(e) in top_node_ids
        ]

        # Build dependency graph
        dependencies = {node["id"]: [] for node in top_nodes}
        dependents = {node["id"]: [] for node in top_nodes}
        in_degree = {node["id"]: 0 for node in top_nodes}

        for edge in top_edges:
            from_node = _edge_source(edge)
            to_node = _edge_target(edge)
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
                    node.inputs["dependency_outputs"] = _dependency_outputs_for_node(
                        ctx,
                        completed,
                        dependencies[node_id],
                    )
                    node.inputs["dependency_output_aliases"] = _dependency_output_aliases_for_node(
                        ctx,
                        completed,
                        dependencies[node_id],
                    )
                    node.inputs["prior_messages"] = _chat_log_to_messages(ctx.chat_log)
                    # Start execution
                    task = asyncio.create_task(self._execute_node(ctx, node_id))
                    pending_tasks[node_id] = task
                    # Loop containers don't surface as their own row in the
                    # test panel — their per-round per-child events convey
                    # everything the user needs to see.
                    if node.node_type != "loop":
                        yield {
                            "event": "node.started",
                            "data": {
                                "node_id": node_id,
                                "node_type": node.node_type,
                                "input": node.inputs,
                            },
                        }

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

                            if ctx.nodes[completed_node_id].node_type == "loop":
                                # Fan out per-round per-child events using the
                                # snapshots captured in _execute_subgraph_once.
                                # Each round's input/output is preserved (not
                                # overwritten by later rounds), so the test UI
                                # can show every iteration of every child.
                                # Note: we intentionally do NOT yield the
                                # loop's own node.completed above — its
                                # aggregate output is not actionable for the
                                # user, only the children are.
                                round_traces = output.get("round_traces") or []
                                for round_idx, traces in enumerate(round_traces, start=1):
                                    if not isinstance(traces, dict):
                                        continue
                                    for child_id, trace in traces.items():
                                        if not isinstance(trace, dict):
                                            continue
                                        child = ctx.nodes.get(child_id)
                                        yield {
                                            "event": "node.completed",
                                            "data": {
                                                "node_id": child_id,
                                                "node_type": child.node_type if child else "agent",
                                                "loop_id": completed_node_id,
                                                "round": round_idx,
                                                "input": trace.get("input", {}),
                                                "output": trace.get("output", {}),
                                            },
                                        }
                            else:
                                yield {
                                    "event": "node.completed",
                                    "data": {
                                        "node_id": completed_node_id,
                                        "node_type": ctx.nodes[completed_node_id].node_type,
                                        "input": ctx.nodes[completed_node_id].inputs,
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
                                    "input": ctx.nodes[completed_node_id].inputs,
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
        elif node.node_type == "input":
            return await self._execute_input_node(ctx, node_id)
        elif node.node_type == "output":
            return await self._execute_output_node(ctx, node_id)
        else:
            raise ValueError(f"Unknown node type: {node.node_type}")

    async def _execute_input_node(self, ctx: OrchestrationContext, node_id: str) -> dict:
        """Produce the workflow's entry payload.

        Downstream agents pick this up from their `dependency_outputs[input_id]`
        and it gives them, in one structured bundle, everything the user
        supplied: the selection, the instruction, any @-mentioned files, and any
        user-defined extras. The `include_instruction` flag lets a workflow
        author hide the instruction from the rest of the graph when the agents
        are supposed to react purely to the selected text.
        """
        node = ctx.nodes[node_id]
        node.status = "running"
        node.started_at = datetime.utcnow()

        try:
            include_instruction = node.config.get("include_instruction", True)
            extra_inputs = node.config.get("extra_inputs") or {}

            output = {
                "text": ctx.target_text,
                "target_text": ctx.target_text,
                "user_instruction": ctx.user_instruction if include_instruction else "",
                "context_files": list(ctx.context_files),
                "extra": dict(extra_inputs) if isinstance(extra_inputs, dict) else {},
                "node_id": node_id,
            }

            node.outputs = output
            node.status = "completed"
            node.finished_at = datetime.utcnow()
            _seed_chat_from_input_node(ctx, node_id, output, include_instruction=include_instruction)
            return output

        except Exception as e:
            node.status = "failed"
            node.error = str(e)
            node.finished_at = datetime.utcnow()
            raise

    async def _execute_output_node(self, ctx: OrchestrationContext, node_id: str) -> dict:
        """Aggregate upstream outputs according to the configured `format`.

        Formats:
          - text:        concatenate each upstream's `.text` with a separator.
          - json:        shallow-merge each upstream dict (later keys win); if
                         upstream is a JSON string, parse it first, otherwise
                         slot it under its node_id.
          - annotations: pass upstream payloads through untouched, labeled by
                         node_id. The frontend parseDifyOutputs then routes them
                         into the annotation/suggestion/risk panes.
        """
        node = ctx.nodes[node_id]
        node.status = "running"
        node.started_at = datetime.utcnow()

        try:
            dep_outputs = node.inputs.get("dependency_outputs") or {}
            dep_aliases = node.inputs.get("dependency_output_aliases") or {}
            source_ids = node.config.get("source_node_ids") or []
            fmt = node.config.get("format", "text")

            # If source_node_ids is specified, restrict to those; otherwise use
            # every dependency the DAG scheduler wired into this node.
            if isinstance(source_ids, list) and source_ids:
                allowed_ids = set(source_ids)
                for source_id in source_ids:
                    alias_targets = dep_aliases.get(source_id)
                    if isinstance(alias_targets, list):
                        allowed_ids.update(str(target) for target in alias_targets)
                dep_outputs = {k: v for k, v in dep_outputs.items() if k in allowed_ids}

            if fmt == "text":
                aggregated = _aggregate_as_text(dep_outputs)
                output = {
                    "text": aggregated,
                    "outputs": {"text": aggregated},
                    "format": "text",
                    "sources": list(dep_outputs.keys()),
                    "node_id": node_id,
                }
            elif fmt == "json":
                merged = _aggregate_as_json(dep_outputs)
                output = {
                    "text": "",
                    "outputs": merged,
                    "format": "json",
                    "sources": list(dep_outputs.keys()),
                    "node_id": node_id,
                }
            else:  # "annotations"
                structured = _aggregate_as_annotation_schema(dep_outputs)
                output = {
                    "text": "",
                    "outputs": structured,
                    "format": "annotations",
                    "sources": list(dep_outputs.keys()),
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
                project_id=ctx.workflow_run.project_id,
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
        """Execute a loop container: run its child subgraph `rounds` times.

        The loop node holds children via `config._ui.parent_id` on each child.
        Children can themselves be agents or nested loops; this method recurses
        via _execute_subgraph_once, which delegates loop children back here.

        Termination: either `rounds` iterations elapse, or (future work) a
        user-supplied stop_condition evaluates truthy against last output.
        """
        node = ctx.nodes[node_id]
        node.status = "running"
        node.started_at = datetime.utcnow()

        rounds = int(node.config.get("rounds", 3))
        graph_nodes = ctx.workflow_def.graph.get("nodes", [])
        graph_edges = ctx.workflow_def.graph.get("edges", [])

        # Direct children of this loop (not transitively — nested loops handle
        # their own descendants).
        child_nodes = [n for n in graph_nodes if _parent_id(n) == node_id]
        child_ids = {n["id"] for n in child_nodes}
        # Edges fully contained inside this loop's child set.
        child_edges = [
            e for e in graph_edges
            if _edge_source(e) in child_ids and _edge_target(e) in child_ids
        ]
        entry_child_ids = _loop_entry_child_ids(graph_edges, node_id, child_ids)
        exit_child_ids = _loop_exit_child_ids(graph_edges, node_id, child_ids)
        if not entry_child_ids:
            internal_targets = {_edge_target(e) for e in child_edges}
            entry_child_ids = [child_id for child_id in child_ids if child_id not in internal_targets]

        round_outputs: list[dict] = []
        round_traces: list[dict] = []
        next_round_feedback: dict[str, dict] | None = None
        for round_num in range(1, rounds + 1):
            loop_inputs = (
                next_round_feedback
                if next_round_feedback is not None
                else dict(node.inputs.get("dependency_outputs") or {})
            )
            initial_inputs = {
                child_id: loop_inputs
                for child_id in entry_child_ids
                if loop_inputs
            }
            outputs_this_round, traces_this_round = await self._execute_subgraph_once(
                ctx,
                child_nodes,
                child_edges,
                round_num,
                initial_inputs=initial_inputs,
            )
            round_outputs.append(outputs_this_round)
            round_traces.append(traces_this_round)
            next_round_feedback = _select_loop_feedback(
                outputs_this_round,
                child_edges,
                exit_child_ids,
            )

        node.outputs = {
            "text": _aggregate_as_text(next_round_feedback or {}),
            "rounds": rounds,
            "last_round_outputs": round_outputs[-1] if round_outputs else {},
            # Consumable data-flow output for downstream nodes. The loop itself
            # is only a control-flow container; information comes from the
            # exit/terminal child nodes that produced it.
            "data_outputs": next_round_feedback or {},
            "all_rounds": round_outputs,
            # Per-round per-child input/output snapshots used by _execute_graph
            # to fan out node.completed events. Format:
            #   [{child_id: {input, output}}, ...]   indexed by round - 1
            "round_traces": round_traces,
            "node_id": node_id,
        }
        node.status = "completed"
        node.finished_at = datetime.utcnow()
        return node.outputs

    async def _execute_subgraph_once(
        self,
        ctx: OrchestrationContext,
        sub_nodes: list[dict],
        sub_edges: list[dict],
        round_num: int,
        initial_inputs: dict[str, dict[str, dict]] | None = None,
    ) -> tuple[dict[str, dict], dict[str, dict]]:
        """Run a subgraph (loop body or similar) once.

        Returns (outputs, traces) where:
          - outputs: nodeId → child output (used internally for downstream wiring)
          - traces:  nodeId → {"input": <snapshot>, "output": <output>}; the
            input snapshot is taken right before the child runs so each round
            captures what *that round's* child saw, not the final state.

        Mirrors _execute_graph's DAG scheduler but scoped to a node subset.
        Does NOT emit outer events — _execute_graph fans them out per round
        once the loop completes.
        """
        ids = {n["id"] for n in sub_nodes}
        dependencies: dict[str, list[str]] = {nid: [] for nid in ids}
        in_degree: dict[str, int] = {nid: 0 for nid in ids}
        dependents: dict[str, list[str]] = {nid: [] for nid in ids}
        for e in sub_edges:
            src, tgt = _edge_source(e), _edge_target(e)
            dependencies[tgt].append(src)
            dependents[src].append(tgt)
            in_degree[tgt] += 1

        completed: dict[str, dict] = {}
        traces: dict[str, dict] = {}
        input_snapshots: dict[str, dict] = {}
        pending: dict[str, asyncio.Task] = {}
        initial_inputs = initial_inputs or {}
        ready = [nid for nid, d in in_degree.items() if d == 0]

        while ready or pending:
            for nid in ready:
                node_ctx = ctx.nodes[nid]
                dependency_outputs = _dependency_outputs_for_node(
                    ctx,
                    completed,
                    dependencies[nid],
                )
                dependency_outputs.update(initial_inputs.get(nid, {}))
                node_ctx.inputs["dependency_outputs"] = dependency_outputs
                node_ctx.inputs["dependency_output_aliases"] = _dependency_output_aliases_for_node(
                    ctx,
                    completed,
                    dependencies[nid],
                )
                node_ctx.inputs["current_round"] = round_num
                node_ctx.inputs["prior_messages"] = _chat_log_to_messages(ctx.chat_log)
                # Deep-ish copy of inputs so the trace survives subsequent
                # rounds overwriting node_ctx.inputs.
                input_snapshots[nid] = _snapshot_inputs(node_ctx.inputs)
                pending[nid] = asyncio.create_task(self._execute_node(ctx, nid))
            ready = []

            if pending:
                done, _ = await asyncio.wait(
                    pending.values(), return_when=asyncio.FIRST_COMPLETED
                )
                for task in done:
                    done_id = next((k for k, v in pending.items() if v == task), None)
                    if not done_id:
                        continue
                    try:
                        output = await task
                        completed[done_id] = output
                        traces[done_id] = {
                            "input": input_snapshots.get(done_id, {}),
                            "output": output,
                        }
                        for dep_of in dependents[done_id]:
                            in_degree[dep_of] -= 1
                            if in_degree[dep_of] == 0:
                                ready.append(dep_of)
                    except Exception as e:
                        err_output = {"error": str(e), "node_id": done_id}
                        completed[done_id] = err_output
                        traces[done_id] = {
                            "input": input_snapshots.get(done_id, {}),
                            "output": err_output,
                            "error": str(e),
                        }
                    del pending[done_id]

        return completed, traces

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

            resolved = self.agent_registry.resolve(
                agent_id,
                user_id=ctx.workflow_def.user_id,
                project_id=ctx.workflow_def.project_id,
                require_enabled=True,
            )
            if resolved is None:
                raise ValueError(f"Agent {agent_id} not found or disabled")

            # Build prompt with context
            prompt = self._build_agent_prompt(ctx, node)

            if resolved.source == "native":
                output = await self._execute_native_agent_node(ctx, node, agent_id, prompt, resolved)
                node.outputs = output
                node.status = "completed"
                node.finished_at = datetime.utcnow()
                ctx.workflow_run.trace.append({
                    "node_id": node_id,
                    "agent_id": agent_id,
                    "agent_source": "native",
                    "started_at": node.started_at.isoformat(),
                    "finished_at": node.finished_at.isoformat(),
                    "status": "completed",
                    "input": node.inputs,
                    "output": output,
                })
                self.db.commit()
                return output

            # Execute agent based on provider type
            provider = resolved.provider
            cached_workflow = resolved.cached_workflow
            if cached_workflow is None:
                raise ValueError(f"External agent {agent_id} not found")
            client = self.provider_service.make_client(provider)

            if provider.kind.startswith("dify"):
                if not isinstance(client, DifyClient):
                    raise TypeError("Expected DifyClient for dify provider")

                # Collect streaming output
                accumulated_text = ""
                prior_messages = node.inputs.get("prior_messages")
                if not isinstance(prior_messages, list):
                    prior_messages = _chat_log_to_messages(ctx.chat_log)
                dify_prompt = _messages_to_text_prompt(prior_messages, prompt)
                async for evt in client.run_streaming(
                    workflow_id=cached_workflow.external_id,
                    inputs={"query": dify_prompt},
                    user="orchestrator",
                ):
                    if evt.get("event") == "text_chunk":
                        accumulated_text += evt.get("data", "")

                output = {"text": _strip_thinking(accumulated_text).strip(), "agent_id": agent_id}

            elif provider.kind == "nanobot":
                if not isinstance(client, NanobotClient):
                    raise TypeError("Expected NanobotClient for nanobot provider")

                # Collect streaming output
                accumulated_text = ""
                prior_messages = node.inputs.get("prior_messages")
                if not isinstance(prior_messages, list):
                    prior_messages = _chat_log_to_messages(ctx.chat_log)
                async for evt in client.run_streaming(
                    model=cached_workflow.external_id,
                    messages=[*prior_messages, {"role": "user", "content": prompt}],
                    session_id=None,
                ):
                    delta = evt.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    accumulated_text += delta

                output = {"text": _strip_thinking(accumulated_text).strip(), "agent_id": agent_id}

            else:
                raise ValueError(f"Unsupported provider kind: {provider.kind}")

            _append_agent_turn(
                ctx,
                node,
                agent_id=agent_id,
                agent_name=cached_workflow.name if cached_workflow else agent_id,
                text=output.get("text", ""),
            )
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

    async def _execute_native_agent_node(
        self,
        ctx: OrchestrationContext,
        node: NodeContext,
        agent_id: str,
        prompt: str,
        resolved,
    ) -> dict:
        native_agent = resolved.native_agent
        provider = resolved.provider
        if native_agent is None:
            raise ValueError(f"Native agent {agent_id} not found")
        skills = self.agent_registry.skill_blocks_for_native_agent(
            native_agent,
            user_id=ctx.workflow_def.user_id,
        )
        workspace_root = AgentWorkspaceService(self.db).ensure_workspace(native_agent)
        runtime_config = McpConfigService(self.db).resolve_runtime_config(
            user_id=ctx.workflow_def.user_id,
            runtime_config=native_agent.runtime_config or {},
        )
        runner = NativeAgentRunner(
            NativeAgentRuntimeConfig(
                agent_id=native_agent.id,
                agent_name=native_agent.name,
                provider_endpoint=provider.endpoint,
                api_key=decrypt(provider.api_key_enc),
                model=native_agent.model,
                instructions=native_agent.instructions,
                skills=skills,
                workspace_root=str(workspace_root),
                project_id=ctx.workflow_def.project_id,
                user_id=ctx.workflow_def.user_id,
                temperature=float(runtime_config.get("temperature", 0.2)),
                max_tokens=int(runtime_config.get("max_tokens", 4000)),
                runtime_config=runtime_config,
            )
        )
        accumulated_text: list[str] = []
        activated_skills: list[dict] = []
        prior_messages = node.inputs.get("prior_messages")
        if not isinstance(prior_messages, list):
            prior_messages = _chat_log_to_messages(ctx.chat_log)
        allow_project_context = _node_allows_project_context(node)
        payload = NativeRunPayload(
            document_id=ctx.document_id,
            range_start=ctx.target_range.get("from", 0),
            range_end=ctx.target_range.get("to", 0),
            inputs={
                "target_text": ctx.target_text,
                "instruction": prompt,
                "allow_project_context": allow_project_context,
            },
            query=prompt,
            conversation_id="",
            context_files=list(ctx.context_files or []),
            prior_messages=prior_messages,
            allow_project_context=allow_project_context,
        )
        request_audit = {
            "document_id": payload.document_id,
            "range_start": payload.range_start,
            "range_end": payload.range_end,
            "query": payload.query,
            "inputs": dict(payload.inputs or {}),
            "context_files": list(payload.context_files or []),
            "prior_messages": list(payload.prior_messages or []),
            "allow_project_context": allow_project_context,
        }
        prompt_audit = runner.prompt_audit_payload(payload)
        async for evt in runner.stream(payload):
            data = evt.get("data") or {}
            if evt.get("event") == "native.agent.output.delta" and isinstance(data, dict):
                delta = data.get("delta")
                if isinstance(delta, str):
                    accumulated_text.append(delta)
            elif evt.get("event") == "native.agent.skill.activated" and isinstance(data, dict):
                activated_skills.append(data)
        text = _strip_thinking("".join(accumulated_text)).strip()
        _append_agent_turn(
            ctx,
            node,
            agent_id=agent_id,
            agent_name=native_agent.name,
            text=text,
        )
        return {
            "text": text,
            "agent_id": agent_id,
            "agent_source": "native",
            "model": native_agent.model,
            "native_agent_id": native_agent.id,
            "activated_skills": activated_skills,
            "request": request_audit,
            "prompt_audit": prompt_audit,
        }

    def _build_agent_prompt(self, ctx: OrchestrationContext, node: NodeContext) -> str:
        """Build prompt for agent with context from previous outputs.

        Injects workflow context so the agent knows:
        - It's part of a multi-agent workflow
        - What inputs it's receiving from upstream nodes
        - Any referenced files (either via upstream input node or ctx fallback)
        - Any node-specific instructions (additional_prompt)
        - REQ-0034: per-doc annotation review states + recent evaluations,
          so Reviewer doesn't repeat dismissed/addressed feedback and Writer
          can prioritise high-value `open` items.
        """
        parts = []

        # === Annotation review state (REQ-0034 task 4.3) ===
        review_block = self._build_annotation_review_block(ctx)
        if review_block:
            parts.append(review_block)

        # === Workflow context header ===
        additional_prompt = node.config.get("additional_prompt")
        dependency_outputs = node.inputs.get("dependency_outputs", {})
        prior_messages = node.inputs.get("prior_messages")
        in_workflow_chat = isinstance(prior_messages, list) and bool(prior_messages)
        allow_project_context = _node_allows_project_context(node)

        if additional_prompt or dependency_outputs or in_workflow_chat:
            parts.append("[WORKFLOW CONTEXT]")
            parts.append("You are part of a multi-agent workflow.")
            parts.append(
                "Read prior_messages as the shared group-chat history. "
                "Continue from it, but output only this Agent node's final answer. "
                "Do not include hidden reasoning, scratchpad, or <think> blocks."
            )
            if in_workflow_chat:
                parts.append(
                    "The original user task inside prior_messages has highest priority. "
                    "Node-specific instructions are lower-priority role or format "
                    "guidance; follow them only when they do not conflict with the "
                    "visible user task or group-chat history."
                )
                parts.append(
                    "Speaker labels such as [node round N] in prior_messages are "
                    "metadata. Do not copy, continue, or invent bracketed speaker "
                    "labels in your own output unless the user explicitly asks for them."
                )
                if allow_project_context:
                    parts.append(
                        "Project document access is enabled for this node; use it only "
                        "when the current node instructions explicitly require project context."
                    )
                else:
                    parts.append(
                        "Project document access is disabled for this node; do not infer "
                        "or fetch context outside prior_messages."
                    )

            if dependency_outputs:
                parts.append(f"\nYou have {len(dependency_outputs)} upstream input(s):")
                for dep_id, dep_output in dependency_outputs.items():
                    dep_text = str(dep_output.get("text", ""))
                    preview = dep_text[:150]
                    suffix = "..." if len(dep_text) > 150 else ""
                    parts.append(f"  - {dep_id}: {preview}{suffix}")

            if additional_prompt:
                parts.append(
                    "\nNode-specific role/format guidance "
                    f"(lower priority than prior_messages):\n{additional_prompt}"
                )

            parts.append("\n[END WORKFLOW CONTEXT]\n")

        # === Referenced files ===
        # Files reach agents via the upstream input node's context_files (when
        # present) or directly from the run-level context_files (legacy /
        # no-input-node workflows). Surface them verbatim so any agent can
        # consume them, regardless of file-tool support.
        reference_files = self._collect_reference_files(ctx, node)
        if reference_files:
            parts.append("[REFERENCE FILES]")
            for f in reference_files:
                name = f.get("name") or f.get("document_id") or "file"
                content = f.get("content") or ""
                parts.append(f"\n--- {name} ---\n{content}")
            parts.append("\n[END REFERENCE FILES]\n")

        # In workflow-chat mode, the user's original instruction and target
        # text already live in prior_messages as the input-node/user turn.
        # Legacy direct modes keep the old single-prompt behavior.
        if not in_workflow_chat:
            if ctx.user_instruction:
                parts.append(f"User instruction: {ctx.user_instruction}")
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

    def _build_annotation_review_block(self, ctx: OrchestrationContext) -> str:
        """Compact summary of this doc's annotation review state + recent
        evaluations, for inclusion in the agent prompt (REQ-0034 task 4.3).

        Pulls from annotation_review_states + annotation_evaluations via
        evaluation_service. Only annotations that the user has touched —
        either by setting a non-default review_status or by submitting an
        evaluation — appear, so untouched annotations don't bloat prompts.

        Returns the empty string when there's nothing to say.
        """
        try:
            # Local import to keep orchestrator import-time cheap.
            from . import evaluation_service

            entries = evaluation_service.review_summary_for_doc(
                ctx.db, ctx.document_id, user_id=ctx.workflow_run.user_id
            )
        except Exception:  # pragma: no cover — never break a workflow on this
            return ""
        if not entries:
            return ""

        lines: list[str] = [
            "[ANNOTATION REVIEW STATE]",
            "Per-annotation user feedback gathered so far on this document.",
            (
                "Rules: do NOT modify review_status (the user controls it). "
                "For annotations marked `dismissed`, do not repeat the same "
                "point — the user has rejected that line of feedback. For "
                "`addressed`, the user considers it resolved; only revisit if "
                "new information clearly invalidates the resolution. Prefer "
                "focusing new suggestions on `open` annotations, especially "
                "those previously tagged #高价值."
            ),
        ]
        for entry in entries:
            ann_id = entry["annotation_id"]
            status = entry["review_status"]
            evals = entry.get("evaluations", [])
            if evals:
                verdict_glyphs = "".join(
                    "✅" if e["verdict"] == "positive" else "❎" for e in evals
                )
                # Top-N tags across these evaluations
                tag_counts: dict[str, int] = {}
                for e in evals:
                    for tag in e.get("tags") or []:
                        tag_counts[tag] = tag_counts.get(tag, 0) + 1
                top_tags = ", ".join(
                    f"#{t}"
                    for t, _ in sorted(
                        tag_counts.items(), key=lambda kv: -kv[1]
                    )[:3]
                )
                tail = f" — {verdict_glyphs}"
                if top_tags:
                    tail += f" ({top_tags})"
            else:
                tail = ""
            lines.append(f"  - {ann_id}: {status}{tail}")
        lines.append("[END ANNOTATION REVIEW STATE]\n")
        return "\n".join(lines)

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

    def _collect_reference_files(
        self, ctx: OrchestrationContext, node: NodeContext,
    ) -> list[dict]:
        """Return files that should reach this agent as [REFERENCE FILES].

        Priority:
          1. An upstream input node's context_files (preferred — topology-aware)
          2. Run-level ctx.context_files (legacy / no input node present)
        """
        dep_outputs = node.inputs.get("dependency_outputs") or {}
        for dep in dep_outputs.values():
            if not isinstance(dep, dict):
                continue
            files = dep.get("context_files")
            if isinstance(files, list) and files:
                return [f for f in files if isinstance(f, dict)]
        return [f for f in ctx.context_files if isinstance(f, dict)]

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
            src = _edge_source(edge)
            tgt = _edge_target(edge)
            graph[src].append(tgt)
            in_degree[tgt] += 1

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


# ---------------------------------------------------------------------------
# Edge / node helpers
# ---------------------------------------------------------------------------
#
# Frontend canvas serializes edges as {source, target}; older backend code used
# {from, to}. These helpers accept both so we don't break legacy workflows.


def _snapshot_inputs(inputs: dict) -> dict:
    """Shallow-copy a node's inputs dict so a later round's overwrite of
    `dependency_outputs` doesn't mutate the trace we already captured.

    Goes one level deep on `dependency_outputs` because that's the field the
    loop scheduler rewrites between rounds; the upstream output dicts inside
    it are themselves immutable enough (each round produces fresh dicts).
    """
    out = dict(inputs)
    dep = out.get("dependency_outputs")
    if isinstance(dep, dict):
        out["dependency_outputs"] = dict(dep)
    aliases = out.get("dependency_output_aliases")
    if isinstance(aliases, dict):
        out["dependency_output_aliases"] = {
            key: list(value) if isinstance(value, list) else value
            for key, value in aliases.items()
        }
    pm = out.get("prior_messages")
    if isinstance(pm, list):
        out["prior_messages"] = [dict(m) if isinstance(m, dict) else m for m in pm]
    return out


def _dependency_outputs_for_node(
    ctx: OrchestrationContext,
    completed: dict[str, dict],
    dependency_ids: list[str],
) -> dict[str, dict]:
    """Build data-flow inputs for a node from completed control dependencies.

    Loop containers remain in the DAG so they can order execution, but their
    downstream data must come from the child nodes that actually produced the
    final loop output.
    """
    outputs: dict[str, dict] = {}
    for dep_id in dependency_ids:
        dep_output = completed[dep_id]
        dep_node = ctx.nodes.get(dep_id)
        if dep_node and dep_node.node_type == "loop":
            data_outputs = _loop_data_outputs(dep_output)
            if data_outputs:
                outputs.update(data_outputs)
                continue
        outputs[dep_id] = dep_output
    return outputs


def _dependency_output_aliases_for_node(
    ctx: OrchestrationContext,
    completed: dict[str, dict],
    dependency_ids: list[str],
) -> dict[str, list[str]]:
    aliases: dict[str, list[str]] = {}
    for dep_id in dependency_ids:
        dep_node = ctx.nodes.get(dep_id)
        if not dep_node or dep_node.node_type != "loop":
            continue
        data_outputs = _loop_data_outputs(completed[dep_id])
        if data_outputs:
            aliases[dep_id] = list(data_outputs.keys())
    return aliases


def _loop_data_outputs(output: dict) -> dict[str, dict]:
    if not isinstance(output, dict):
        return {}
    data_outputs = output.get("data_outputs")
    if not isinstance(data_outputs, dict):
        return {}
    return {
        node_id: node_output
        for node_id, node_output in data_outputs.items()
        if isinstance(node_id, str) and isinstance(node_output, dict)
    }


def _producer_outputs(outputs_by_id: dict[str, dict], node_ids: list[str]) -> dict[str, dict]:
    """Return concrete producer outputs, flattening nested loop summaries."""
    outputs: dict[str, dict] = {}
    for node_id in node_ids:
        node_output = outputs_by_id.get(node_id)
        if not isinstance(node_output, dict):
            continue
        nested = _loop_data_outputs(node_output)
        if nested:
            outputs.update(nested)
        else:
            outputs[node_id] = node_output
    return outputs


def _node_allows_project_context(node: NodeContext) -> bool:
    config = node.config or {}
    for key in (
        "allow_project_context",
        "allowProjectContext",
        "allow_file_context",
        "allowFileContext",
    ):
        if key in config:
            return _truthy(config.get(key))

    prompt = str(config.get("additional_prompt") or "")
    return _prompt_requests_project_context(prompt)


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().casefold() in {"1", "true", "yes", "on", "允许", "是"}
    return bool(value)


_PROJECT_CONTEXT_INTENT_PATTERNS = (
    "读取项目",
    "读取文档",
    "读项目",
    "读文档",
    "检索项目",
    "检索文档",
    "搜索项目",
    "搜索文档",
    "参考项目",
    "参考文档",
    "查看项目",
    "查看文档",
    "当前文档",
    "项目文档",
    "read project",
    "read document",
    "read file",
    "search project",
    "search document",
    "project context",
    "project documents",
    "active document",
    "current document",
    "project_read_doc",
    "project_grep",
)


def _prompt_requests_project_context(prompt: str) -> bool:
    text = prompt.casefold()
    return any(pattern in text for pattern in _PROJECT_CONTEXT_INTENT_PATTERNS)


def _seed_chat_from_request(ctx: OrchestrationContext) -> None:
    if ctx.chat_log:
        return
    output = {
        "target_text": ctx.target_text,
        "user_instruction": ctx.user_instruction,
    }
    _seed_chat_from_input_node(ctx, "input", output, include_instruction=True)


def _seed_chat_from_input_node(
    ctx: OrchestrationContext,
    node_id: str,
    output: dict,
    *,
    include_instruction: bool,
) -> None:
    if any(entry.get("role") == "user" and entry.get("node_id") == node_id for entry in ctx.chat_log):
        return
    instruction = str(output.get("user_instruction") or "").strip() if include_instruction else ""
    target = str(output.get("target_text") or output.get("text") or "").strip()
    parts: list[str] = []
    if instruction:
        parts.append(instruction)
    if target and target != instruction:
        parts.append(target)
    content = "\n\n".join(parts).strip()
    if not content:
        return
    ctx.chat_log.append(
        {
            "role": "user",
            "agent_id": "",
            "agent_name": "user",
            "node_id": node_id,
            "loop_id": None,
            "round": None,
            "content": content,
        }
    )


def _append_agent_turn(
    ctx: OrchestrationContext,
    node: NodeContext,
    *,
    agent_id: str,
    agent_name: str,
    text: str,
) -> None:
    content = _strip_thinking(text).strip()
    if not content:
        return
    ctx.chat_log.append(
        {
            "role": "assistant",
            "agent_id": agent_id,
            "agent_name": agent_name,
            "node_id": node.node_id,
            "loop_id": _node_loop_id(ctx, node.node_id),
            "round": node.inputs.get("current_round"),
            "content": content,
        }
    )


def _chat_log_to_messages(chat_log: list[dict]) -> list[dict]:
    messages: list[dict] = []
    for entry in chat_log:
        text = _strip_thinking(str(entry.get("content") or "")).strip()
        if not text:
            continue
        role = entry.get("role") or "assistant"
        if role == "user":
            messages.append({"role": "user", "content": text})
            continue
        speaker = entry.get("node_id") or entry.get("agent_name") or "agent"
        round_num = entry.get("round")
        prefix = f"[{speaker}"
        if isinstance(round_num, int):
            prefix += f" round {round_num}"
        prefix += "]\n"
        messages.append({"role": "assistant", "content": prefix + text})
    return messages


def _messages_to_text_prompt(prior_messages: list[dict], current_prompt: str) -> str:
    if not prior_messages:
        return current_prompt
    lines: list[str] = [
        "[PRIOR MESSAGES]",
        "Treat this as the shared workflow group chat so far.",
    ]
    for message in prior_messages:
        role = str(message.get("role") or "assistant").strip() or "assistant"
        content = str(message.get("content") or "").strip()
        if content:
            lines.append(f"\n{role.upper()}:\n{content}")
    lines.extend(
        [
            "\n[END PRIOR MESSAGES]",
            "\n[CURRENT NODE CONTEXT]",
            current_prompt.strip() or "Continue from the prior messages.",
            "[END CURRENT NODE CONTEXT]",
        ]
    )
    return "\n".join(lines).strip()


_THINKING_RE = re.compile(
    r"<\s*(think|thinking|thought|reasoning|reflection)\s*>.*?<\s*/\s*\1\s*>",
    re.DOTALL | re.IGNORECASE,
)


def _strip_thinking(text: str) -> str:
    if not text:
        return text
    cleaned = _THINKING_RE.sub("", text)
    half_open = re.search(
        r"<\s*(think|thinking|thought|reasoning|reflection)\s*>",
        cleaned,
        re.IGNORECASE,
    )
    if half_open:
        cleaned = cleaned[: half_open.start()]
    return cleaned


def _edge_source(edge: dict) -> str:
    return edge.get("source") or edge.get("from", "")


def _edge_target(edge: dict) -> str:
    return edge.get("target") or edge.get("to", "")


def _parent_id(node: dict) -> str | None:
    """Extract the canvas parent_id (container membership) from a node's config._ui.

    Returns None for top-level nodes (no container).
    """
    config = node.get("config") or {}
    ui = config.get("_ui") or {}
    return ui.get("parent_id")


def _node_loop_id(ctx: OrchestrationContext, node_id: str) -> str | None:
    """Return the loop/container id for a graph node when it is nested."""
    for node in ctx.workflow_def.graph.get("nodes", []):
        if node.get("id") == node_id:
            return _parent_id(node)
    return None


def _loop_child_ids(ctx: OrchestrationContext, loop_id: str) -> list[str]:
    nodes = ctx.workflow_def.graph.get("nodes", [])
    return [n["id"] for n in nodes if _parent_id(n) == loop_id and n["id"] in ctx.nodes]


def _loop_entry_child_ids(edges: list[dict], loop_id: str, child_ids: set[str]) -> list[str]:
    return [
        _edge_target(e)
        for e in edges
        if _edge_source(e) == loop_id
        and e.get("source_handle") == "loop-in-source"
        and _edge_target(e) in child_ids
    ]


def _loop_exit_child_ids(edges: list[dict], loop_id: str, child_ids: set[str]) -> list[str]:
    return [
        _edge_source(e)
        for e in edges
        if _edge_target(e) == loop_id
        and e.get("target_handle") == "loop-out-target"
        and _edge_source(e) in child_ids
    ]


def _select_loop_feedback(
    outputs_this_round: dict[str, dict],
    child_edges: list[dict],
    exit_child_ids: list[str],
) -> dict[str, dict]:
    if exit_child_ids:
        return _producer_outputs(outputs_this_round, exit_child_ids)

    # Fallback for older graphs that have no explicit loop-out-target edge:
    # treat terminal child nodes as the loop's feedback output.
    sources = {_edge_source(e) for e in child_edges}
    targets = {_edge_target(e) for e in child_edges}
    terminal_ids = targets - sources
    if terminal_ids:
        return _producer_outputs(outputs_this_round, list(terminal_ids))
    return dict(outputs_this_round)


def _aggregate_as_text(dep_outputs: dict[str, dict]) -> str:
    """Concat each upstream's text with a source marker."""
    parts: list[str] = []
    for nid, out in dep_outputs.items():
        if isinstance(out, dict):
            text = str(out.get("text") or "").strip()
        else:
            text = str(out).strip()
        if text:
            parts.append(f"[{nid}]\n{text}")
    return "\n\n---\n\n".join(parts)


def _aggregate_as_json(dep_outputs: dict[str, dict]) -> dict:
    """Shallow-merge upstream structured outputs for Output(format=json)."""
    import json as _json

    merged: dict = {}
    for nid, out in dep_outputs.items():
        if not isinstance(out, dict):
            merged[nid] = out
            continue

        payload = out.get("outputs") if isinstance(out.get("outputs"), dict) else out
        if isinstance(payload, dict):
            merged.update(payload)
            continue

        raw_text = str(out.get("text") or out.get("answer") or out.get("result") or "").strip()
        if raw_text:
            try:
                parsed = _json.loads(raw_text)
                if isinstance(parsed, dict):
                    merged.update(parsed)
                else:
                    merged[nid] = parsed
            except Exception:
                merged[nid] = raw_text
    return merged


def _aggregate_as_annotation_schema(dep_outputs: dict[str, dict]) -> dict:
    """Translate upstream outputs into parseDifyOutputs-compatible annotation schema.

    Rules:
      1. If upstream already produced {annotations,suggestions,risks}, keep them.
      2. Else try to parse JSON from its text/result/answer.
      3. Else degrade plain text into a generic comment annotation.

    This keeps `output.format = "annotations"` faithful to the annotation panel
    contract while still tolerating mixed upstream nodes.
    """
    import json as _json

    annotations: list[dict] = []
    suggestions: list[dict] = []
    risks: list[dict] = []

    def merge_structured(payload: dict) -> bool:
        hit = False
        if isinstance(payload.get("annotations"), list):
            annotations.extend([a for a in payload["annotations"] if isinstance(a, dict)])
            hit = True
        if isinstance(payload.get("suggestions"), list):
            suggestions.extend([s for s in payload["suggestions"] if isinstance(s, dict)])
            hit = True
        if isinstance(payload.get("risks"), list):
            risks.extend([r for r in payload["risks"] if isinstance(r, dict)])
            hit = True
        return hit

    for nid, out in dep_outputs.items():
        if not isinstance(out, dict):
            raw = str(out).strip()
            if raw:
                annotations.append({
                    "content": raw,
                    "type": "comment",
                    "severity": "medium",
                    "tags": [nid],
                })
            continue

        payload = out.get("outputs") if isinstance(out.get("outputs"), dict) else out

        # 1) already structured
        if merge_structured(payload):
            continue

        # 2) JSON encoded in text/result/answer
        raw_text = str(payload.get("text") or payload.get("answer") or payload.get("result") or "").strip()
        if raw_text:
            try:
                parsed = _json.loads(raw_text)
                if isinstance(parsed, dict) and merge_structured(parsed):
                    continue
            except Exception:
                pass

        # 3) generic fallback comment
        if raw_text:
            annotations.append({
                "content": raw_text,
                "type": "comment",
                "severity": "medium",
                "tags": [nid],
            })

    return {
        "annotations": annotations,
        "suggestions": suggestions,
        "risks": risks,
    }

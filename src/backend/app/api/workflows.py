"""/api/workflows — list providers' cached workflows + run streaming + continue thread."""

from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from ..database import get_session
from ..models import CachedWorkflow, WorkflowDefinition, WorkflowRun
from ..schemas import CachedWorkflowOut, WorkflowDefinitionIn, WorkflowDefinitionOut, WorkflowRunOut
from ..services.agent_orchestrator import WorkflowOrchestrator
from ..services.dify_client import DifyError
from ..services.nanobot_client import NanobotError
from ..services.provider_service import ProviderService

router = APIRouter(prefix="/api/workflows", tags=["workflows"])


@router.get("", response_model=list[CachedWorkflowOut])
def list_workflows(db: Session = Depends(get_session)) -> list[CachedWorkflowOut]:
    """List all cached workflows whose provider still exists.

    Filters out orphan workflows (provider was deleted but CASCADE didn't fire yet).
    """
    from ..models import Provider
    rows = (
        db.query(CachedWorkflow)
        .join(Provider, CachedWorkflow.provider_id == Provider.id)
        .order_by(CachedWorkflow.last_synced_at.desc())
        .all()
    )
    return [CachedWorkflowOut.model_validate(r) for r in rows]


@router.get("/runs", response_model=list[WorkflowRunOut])
def list_runs(
    document_id: str | None = None,
    workflow_id: str | None = None,
    limit: int = 50,
    db: Session = Depends(get_session),
) -> list[WorkflowRunOut]:
    """List recent workflow runs, newest first.

    Optional filters narrow to one document or one workflow. `limit` is
    capped at 200 to avoid pulling the entire history into memory.
    """
    limit = max(1, min(limit, 200))
    q = db.query(WorkflowRun)
    if document_id:
        q = q.filter(WorkflowRun.document_id == document_id)
    if workflow_id:
        q = q.filter(WorkflowRun.workflow_id == workflow_id)
    rows = q.order_by(WorkflowRun.started_at.desc()).limit(limit).all()
    return [WorkflowRunOut.model_validate(r) for r in rows]


@router.get("/runs/{run_id}", response_model=WorkflowRunOut)
def get_run(run_id: str, db: Session = Depends(get_session)) -> WorkflowRunOut:
    run = db.get(WorkflowRun, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    return WorkflowRunOut.model_validate(run)


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: str, db: Session = Depends(get_session)) -> None:
    run = db.get(WorkflowRun, run_id)
    if run is None:
        return None
    db.delete(run)
    db.commit()


@router.post("/{workflow_id}/disable", response_model=CachedWorkflowOut)
def disable_workflow(workflow_id: str, db: Session = Depends(get_session)) -> CachedWorkflowOut:
    """Disable an agent (hide from @mention, prevent follow-up)."""
    cw = db.get(CachedWorkflow, workflow_id)
    if cw is None:
        raise HTTPException(404, "Workflow not found")
    cw.is_disabled = True
    db.commit()
    db.refresh(cw)
    return CachedWorkflowOut.model_validate(cw)


@router.post("/{workflow_id}/enable", response_model=CachedWorkflowOut)
def enable_workflow(workflow_id: str, db: Session = Depends(get_session)) -> CachedWorkflowOut:
    """Enable (reactivate) a disabled agent."""
    cw = db.get(CachedWorkflow, workflow_id)
    if cw is None:
        raise HTTPException(404, "Workflow not found")
    cw.is_disabled = False
    db.commit()
    db.refresh(cw)
    return CachedWorkflowOut.model_validate(cw)


class ContextFileRef(BaseModel):
    """File referenced via @-mention in the run request.

    `content` holds the entire file text — we currently inject it verbatim into
    the agent prompt rather than passing a path, because most agents have no
    file-read tool. Truncation happens at prompt-build time if needed.
    """
    name: str = ""
    document_id: str = ""
    content: str = ""


class RunBody(BaseModel):
    document_id: str
    range_start: int = Field(ge=0)
    range_end: int = Field(ge=0)
    inputs: dict = Field(default_factory=dict)
    user: str = Field(default="yuwanlab-local")
    # Chat-mode fields. Ignored for workflow-mode apps.
    query: str = ""
    conversation_id: str = ""
    # Optional anchor: a parent run id, when this run is a follow-up question.
    parent_run_id: str = ""
    # Referenced files (from @-mention UI). Injected into the workflow's input
    # node output and, for agent nodes downstream, into the prompt itself.
    context_files: list[ContextFileRef] = Field(default_factory=list)


@router.post("/{workflow_id}/run")
async def run_workflow(
    workflow_id: str,
    body: RunBody,
    db: Session = Depends(get_session),
):
    """Proxy a provider run as an SSE stream.

    Dify stays on the existing event contract. Nanobot streams raw OpenAI-like
    SSE events which we forward under a `nanobot` event name, then collapse into
    `outputs.text` for the existing annotation parser.
    """
    cw = db.get(CachedWorkflow, workflow_id)
    if cw is None:
        raise HTTPException(404, "Workflow not found")

    svc = ProviderService(db)
    provider = svc.get(cw.provider_id)
    if provider is None:
        raise HTTPException(404, "Provider for this workflow is gone")

    run = WorkflowRun(
        provider_id=provider.id,
        workflow_id=workflow_id,
        document_id=body.document_id,
        range_start=body.range_start,
        range_end=body.range_end,
        status="running",
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    client = svc.make_client(provider)

    async def event_gen():
        yield {
            "event": "ylw.run.started",
            "data": json.dumps(
                {
                    "run_id": run.id,
                    "workflow_id": workflow_id,
                    "mode": provider.kind if provider.kind == "nanobot" else (provider.meta or {}).get("mode") or cw.kind or "workflow",
                    "parent_run_id": body.parent_run_id,
                }
            ),
        }

        conversation_id = body.conversation_id
        external_run_id = ""
        raw_events: list[dict] = []
        accumulated_text: list[str] = []

        try:
            if provider.kind == "nanobot":
                from ..services.nanobot_client import NanobotClient
                if not isinstance(client, NanobotClient):
                    raise TypeError(f"Expected NanobotClient for nanobot provider, got {type(client)}")
                prompt = _nanobot_prompt(body)
                async for evt in client.run_streaming(
                    model=cw.external_id,
                    messages=[{"role": "user", "content": prompt}],
                ):
                    raw_events.append(evt)
                    if not external_run_id:
                        external_run_id = str(evt.get("id") or evt.get("run_id") or "")
                    text = _nanobot_delta_text(evt)
                    if text:
                        accumulated_text.append(text)
                    yield {"event": "nanobot", "data": json.dumps(evt)}
            else:
                from ..services.dify_client import DifyClient
                if not isinstance(client, DifyClient):
                    raise TypeError(f"Expected DifyClient for dify provider, got {type(client)}")
                mode = (provider.meta or {}).get("mode") or cw.kind or "workflow"
                async for evt in client.run_streaming(
                    mode=mode,
                    inputs=body.inputs,
                    user=body.user,
                    query=body.query,
                    conversation_id=conversation_id,
                ):
                    raw_events.append(evt)
                    if evt.get("workflow_run_id") and not external_run_id:
                        external_run_id = evt["workflow_run_id"]
                    if evt.get("conversation_id"):
                        conversation_id = evt["conversation_id"]
                    yield {"event": "dify", "data": json.dumps(evt)}
        except (DifyError, NanobotError) as e:
            run.status = "failed"
            run.error = f"{e.status}: {e.detail}"
            run.finished_at = datetime.utcnow()
            db.commit()
            yield {"event": "ylw.run.failed", "data": json.dumps({"run_id": run.id, "error": run.error})}
            return
        except Exception as e:  # noqa: BLE001
            run.status = "failed"
            run.error = f"{type(e).__name__}: {e}"[:512]
            run.finished_at = datetime.utcnow()
            db.commit()
            yield {"event": "ylw.run.failed", "data": json.dumps({"run_id": run.id, "error": run.error})}
            return

        outputs = _extract_outputs(raw_events, provider.kind, accumulated_text)

        run.status = "completed"
        run.external_run_id = external_run_id
        run.outputs = {**outputs, "conversation_id": conversation_id}
        run.finished_at = datetime.utcnow()
        db.commit()

        yield {
            "event": "ylw.run.finished",
            "data": json.dumps(
                {
                    "run_id": run.id,
                    "outputs": outputs,
                    "conversation_id": conversation_id,
                    "mode": provider.kind if provider.kind == "nanobot" else (provider.meta or {}).get("mode") or cw.kind or "workflow",
                }
            ),
        }

    return EventSourceResponse(event_gen())


def _nanobot_prompt(body: RunBody) -> str:
    selection_text = str(body.inputs.get("target_text") or body.query or "").strip()
    instruction = str(body.inputs.get("instruction") or body.query or "").strip()
    before = str(body.inputs.get("before") or "").strip()
    after = str(body.inputs.get("after") or "").strip()
    section_title = str(body.inputs.get("section_title") or "").strip()

    parts = []
    if section_title:
        parts.append(f"Section: {section_title}")
    if instruction:
        parts.append(f"Instruction: {instruction}")
    if selection_text:
        parts.append("Selected text:")
        parts.append(selection_text)
    if before or after:
        parts.append("Context:")
        if before:
            parts.append(f"Before: {before}")
        if after:
            parts.append(f"After: {after}")
    return "\n".join(parts).strip() or body.query or selection_text or instruction


def _nanobot_delta_text(evt: dict) -> str:
    choices = evt.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if isinstance(delta, dict):
        content = delta.get("content")
        if isinstance(content, str):
            return content
    message = first.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content
    text = first.get("text")
    if isinstance(text, str):
        return text
    return ""


def _extract_outputs(events: list[dict], provider_kind: str, accumulated_text: list[str]) -> dict:
    if provider_kind == "nanobot":
        text = "".join(accumulated_text).strip()
        last = next((e for e in reversed(events) if isinstance(e, dict)), {})
        return {
            "text": text,
            "outputs": {"text": text},
            "model": last.get("model", ""),
            "raw": events[-20:],
        }

    final = next((e for e in reversed(events) if e.get("event") == "workflow_finished"), None)
    if final is not None:
        return (final.get("data") or {}).get("outputs") or {}

    text_parts: list[str] = []
    structured: dict = {}
    message_id = ""
    for evt in events:
        kind = evt.get("event")
        if kind == "message" and isinstance(evt.get("answer"), str):
            text_parts.append(evt["answer"])
            message_id = evt.get("message_id", message_id)
        elif kind == "agent_message" and isinstance(evt.get("answer"), str):
            text_parts.append(evt["answer"])
            message_id = evt.get("message_id", message_id)
        elif kind == "message_end":
            md = evt.get("metadata") or {}
            if isinstance(md.get("outputs"), dict):
                structured = md["outputs"]
            message_id = evt.get("message_id", message_id)

    return {"text": "".join(text_parts), "outputs": structured, "message_id": message_id}


# ---------------------------------------------------------------------------
# Workflow Definition Management
# ---------------------------------------------------------------------------


@router.get("/definitions", response_model=list[WorkflowDefinitionOut])
def list_workflow_definitions(db: Session = Depends(get_session)) -> list[WorkflowDefinitionOut]:
    """List all workflow definitions."""
    rows = db.query(WorkflowDefinition).filter(WorkflowDefinition.is_active == True).order_by(WorkflowDefinition.updated_at.desc()).all()
    return [WorkflowDefinitionOut.model_validate(r) for r in rows]


@router.get("/definitions/{definition_id}", response_model=WorkflowDefinitionOut)
def get_workflow_definition(definition_id: str, db: Session = Depends(get_session)) -> WorkflowDefinitionOut:
    """Get a specific workflow definition."""
    wf = db.get(WorkflowDefinition, definition_id)
    if wf is None:
        raise HTTPException(404, "Workflow definition not found")
    return WorkflowDefinitionOut.model_validate(wf)


@router.post("/definitions", response_model=WorkflowDefinitionOut)
def create_workflow_definition(body: WorkflowDefinitionIn, db: Session = Depends(get_session)) -> WorkflowDefinitionOut:
    """Create a new workflow definition."""
    wf = WorkflowDefinition(
        name=body.name,
        description=body.description,
        execution_mode=body.execution_mode,
        graph=body.graph,
        config=body.config,
    )
    db.add(wf)
    db.commit()
    db.refresh(wf)
    return WorkflowDefinitionOut.model_validate(wf)


@router.put("/definitions/{definition_id}", response_model=WorkflowDefinitionOut)
def update_workflow_definition(
    definition_id: str,
    body: WorkflowDefinitionIn,
    db: Session = Depends(get_session),
) -> WorkflowDefinitionOut:
    """Update a workflow definition."""
    wf = db.get(WorkflowDefinition, definition_id)
    if wf is None:
        raise HTTPException(404, "Workflow definition not found")

    wf.name = body.name
    wf.description = body.description
    wf.execution_mode = body.execution_mode
    wf.graph = body.graph
    wf.config = body.config
    wf.version += 1
    wf.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(wf)
    return WorkflowDefinitionOut.model_validate(wf)


@router.delete("/definitions/{definition_id}", status_code=204)
def delete_workflow_definition(definition_id: str, db: Session = Depends(get_session)) -> None:
    """Delete (deactivate) a workflow definition."""
    wf = db.get(WorkflowDefinition, definition_id)
    if wf is None:
        return None
    wf.is_active = False
    db.commit()


@router.post("/definitions/{definition_id}/execute")
async def execute_workflow_definition(
    definition_id: str,
    body: RunBody,
    db: Session = Depends(get_session),
):
    """Execute a workflow definition with orchestration.

    Pre-flight checks:
      1. The graph must contain an `input` and an `output` node — they frame
         what the user provided and what will be returned. Enforced here
         rather than in the canvas so API-level callers can't skip it.
      2. Every `agent` node must reference an enabled CachedWorkflow.

    Either failure yields 409 with a code the frontend can branch on.
    """
    wf = db.get(WorkflowDefinition, definition_id)
    if wf is None:
        raise HTTPException(404, "Workflow definition not found")

    boundary_error = _check_boundary_nodes(wf)
    if boundary_error:
        raise HTTPException(status_code=409, detail=boundary_error)

    issues = _collect_unhealthy_agents(wf, db)
    if issues:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "workflow_degraded",
                "message": "Workflow 中存在已禁用或缺失的 Agent，请先编辑后再运行。",
                "issues": issues,
            },
        )

    # TODO: Extract target_text from document
    target_text = body.inputs.get("text", "")
    context_files = [cf.model_dump() for cf in body.context_files]

    orchestrator = WorkflowOrchestrator(db)

    async def event_generator():
        try:
            async for event in orchestrator.execute_workflow(
                workflow_def_id=definition_id,
                document_id=body.document_id,
                target_text=target_text,
                range_start=body.range_start,
                range_end=body.range_end,
                user_instruction=body.query,
                context_files=context_files,
            ):
                yield {"event": event.get("event", "message"), "data": json.dumps(event.get("data", {}))}
        except (DifyError, NanobotError) as e:
            yield {"event": "error", "data": json.dumps({"error": str(e)})}

    return EventSourceResponse(event_generator())


def _check_boundary_nodes(wf: WorkflowDefinition) -> dict | None:
    """Return a 409 detail dict if the graph lacks an input or output node.

    Per product decision: even a pass-through workflow must make its I/O
    contract visible. Enforcing at runtime keeps older canvases (no boundary
    nodes) from silently producing empty payloads.
    """
    nodes = (wf.graph or {}).get("nodes", []) or []
    has_input = any(n.get("type") == "input" for n in nodes)
    has_output = any(n.get("type") == "output" for n in nodes)
    if has_input and has_output:
        return None
    missing: list[str] = []
    if not has_input:
        missing.append("input")
    if not has_output:
        missing.append("output")
    return {
        "code": "workflow_missing_boundary",
        "message": "Workflow 必须包含 input 和 output 节点，请进入编辑器补齐。",
        "missing": missing,
    }


def _collect_unhealthy_agents(
    wf: WorkflowDefinition,
    db: Session,
) -> list[dict]:
    """Return a list of {node_id, agent_id, reason} for every agent node whose
    referenced CachedWorkflow is missing or disabled. Empty list == healthy.
    """
    nodes = (wf.graph or {}).get("nodes", []) or []
    issues: list[dict] = []
    for n in nodes:
        if n.get("type") != "agent":
            continue
        cfg = n.get("config") or {}
        agent_id = cfg.get("agent_id") or cfg.get("agentId") or ""
        if not agent_id:
            continue
        cw = db.get(CachedWorkflow, agent_id)
        if cw is None:
            issues.append({
                "node_id": n.get("id"),
                "agent_id": agent_id,
                "reason": "missing",
            })
            continue
        if cw.is_disabled:
            issues.append({
                "node_id": n.get("id"),
                "agent_id": agent_id,
                "reason": "disabled",
            })
    return issues

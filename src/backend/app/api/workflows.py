"""/api/workflows — list providers' cached workflows + run streaming + continue thread."""

from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from ..database import get_session
from ..models import CachedWorkflow, WorkflowRun
from ..schemas import CachedWorkflowOut, WorkflowRunOut
from ..services.dify_client import DifyError
from ..services.nanobot_client import NanobotError
from ..services.provider_service import ProviderService

router = APIRouter(prefix="/api/workflows", tags=["workflows"])


@router.get("", response_model=list[CachedWorkflowOut])
def list_workflows(db: Session = Depends(get_session)) -> list[CachedWorkflowOut]:
    rows = db.query(CachedWorkflow).order_by(CachedWorkflow.last_synced_at.desc()).all()
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

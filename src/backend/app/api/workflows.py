"""/api/workflows — list Dify apps + run streaming + continue thread."""

from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from ..database import get_session
from ..models import CachedWorkflow, WorkflowRun
from ..schemas import CachedWorkflowOut
from ..services.dify_client import DifyError
from ..services.provider_service import ProviderService

router = APIRouter(prefix="/api/workflows", tags=["workflows"])


@router.get("", response_model=list[CachedWorkflowOut])
def list_workflows(db: Session = Depends(get_session)) -> list[CachedWorkflowOut]:
    rows = db.query(CachedWorkflow).order_by(CachedWorkflow.last_synced_at.desc()).all()
    return [CachedWorkflowOut.model_validate(r) for r in rows]


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
    """Proxy a Dify run as an SSE stream.

    The endpoint dispatches to /workflows/run for workflow apps and
    /chat-messages for chat / advanced-chat / agent-chat apps. We forward every
    Dify event verbatim and add three housekeeping events:
      - ylw.run.started   (with our run_id and resolved Dify mode)
      - ylw.run.finished  (with parsed outputs and conversation_id if any)
      - ylw.run.failed    (with the error string)
    """
    cw = db.get(CachedWorkflow, workflow_id)
    if cw is None:
        raise HTTPException(404, "Workflow not found")

    svc = ProviderService(db)
    provider = svc.get(cw.provider_id)
    if provider is None:
        raise HTTPException(404, "Provider for this workflow is gone")

    mode = (provider.meta or {}).get("mode") or cw.kind or "workflow"

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
                    "mode": mode,
                    "parent_run_id": body.parent_run_id,
                }
            ),
        }

        accumulated: list[dict] = []
        external_run_id = ""
        conversation_id = body.conversation_id
        try:
            async for evt in client.run_streaming(
                mode=mode,
                inputs=body.inputs,
                user=body.user,
                query=body.query,
                conversation_id=conversation_id,
            ):
                accumulated.append(evt)
                if evt.get("workflow_run_id") and not external_run_id:
                    external_run_id = evt["workflow_run_id"]
                if evt.get("conversation_id"):
                    conversation_id = evt["conversation_id"]
                yield {"event": "dify", "data": json.dumps(evt)}
        except DifyError as e:
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

        outputs = _extract_outputs(accumulated, mode)

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
                    "mode": mode,
                }
            ),
        }

    return EventSourceResponse(event_gen())


def _extract_outputs(events: list[dict], mode: str) -> dict:
    """Recover the final output payload regardless of app mode.

    - workflow:     workflow_finished.data.outputs
    - chat-modes:   accumulated `answer` chunks from message events, plus any
                    metadata.outputs from message_end. Returns
                    {"text": <full answer>, "outputs": <structured if any>}
    """
    if mode not in {"chat", "advanced-chat", "agent-chat"}:
        final = next((e for e in reversed(events) if e.get("event") == "workflow_finished"), None)
        return (final or {}).get("data", {}).get("outputs") or {}

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

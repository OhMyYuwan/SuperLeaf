"""/api/conversations — chat-style discussions per (document, agent).

Each conversation maps 1:1 to a Dify conversation_id once it has at least one
message. We persist user/agent turns locally so the UI can rehydrate without
hitting Dify, and so the chat stays coherent if the Dify side resets.
"""

from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import desc, func
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from ..database import get_session
from ..models import CachedWorkflow, Conversation, Message
from ..schemas import (
    ConversationCreateIn,
    ConversationOut,
    ConversationUpdateIn,
    MessageOut,
    MessageSendIn,
)
from ..services.dify_client import DifyError
from ..services.provider_service import ProviderService

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


def _to_out(c: Conversation, *, message_count: int = 0, last_preview: str = "") -> ConversationOut:
    return ConversationOut(
        id=c.id,
        document_id=c.document_id,
        workflow_id=c.workflow_id,
        title=c.title,
        external_conversation_id=c.external_conversation_id,
        created_at=c.created_at,
        updated_at=c.updated_at,
        message_count=message_count,
        last_message_preview=last_preview,
    )


@router.get("", response_model=list[ConversationOut])
def list_conversations(
    document_id: str | None = None,
    workflow_id: str | None = None,
    db: Session = Depends(get_session),
) -> list[ConversationOut]:
    q = db.query(Conversation)
    if document_id:
        q = q.filter(Conversation.document_id == document_id)
    if workflow_id:
        q = q.filter(Conversation.workflow_id == workflow_id)
    rows = q.order_by(desc(Conversation.updated_at)).all()

    if not rows:
        return []

    # Annotate with message_count and last preview in one query each.
    counts = dict(
        db.query(Message.conversation_id, func.count(Message.id))
        .filter(Message.conversation_id.in_([r.id for r in rows]))
        .group_by(Message.conversation_id)
        .all()
    )
    last_msgs: dict[str, str] = {}
    for r in rows:
        msg = (
            db.query(Message)
            .filter(Message.conversation_id == r.id)
            .order_by(desc(Message.created_at))
            .first()
        )
        if msg:
            last_msgs[r.id] = (msg.content or "")[:80]

    return [
        _to_out(r, message_count=counts.get(r.id, 0), last_preview=last_msgs.get(r.id, ""))
        for r in rows
    ]


@router.post("", response_model=ConversationOut, status_code=201)
def create_conversation(
    body: ConversationCreateIn, db: Session = Depends(get_session)
) -> ConversationOut:
    cw = db.get(CachedWorkflow, body.workflow_id)
    if cw is None:
        raise HTTPException(404, "Agent (workflow) not found")
    conv = Conversation(
        document_id=body.document_id,
        workflow_id=body.workflow_id,
        title=body.title or cw.name,
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return _to_out(conv)


@router.get("/{conversation_id}", response_model=ConversationOut)
def get_conversation(conversation_id: str, db: Session = Depends(get_session)) -> ConversationOut:
    c = db.get(Conversation, conversation_id)
    if c is None:
        raise HTTPException(404, "Conversation not found")
    return _to_out(c)


@router.patch("/{conversation_id}", response_model=ConversationOut)
def update_conversation(
    conversation_id: str,
    body: ConversationUpdateIn,
    db: Session = Depends(get_session),
) -> ConversationOut:
    c = db.get(Conversation, conversation_id)
    if c is None:
        raise HTTPException(404, "Conversation not found")
    if body.title is not None:
        c.title = body.title
    c.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(c)
    return _to_out(c)


@router.delete("/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str, db: Session = Depends(get_session)) -> None:
    c = db.get(Conversation, conversation_id)
    if c is None:
        return None
    db.query(Message).filter(Message.conversation_id == conversation_id).delete()
    db.delete(c)
    db.commit()


@router.get("/{conversation_id}/messages", response_model=list[MessageOut])
def list_messages(conversation_id: str, db: Session = Depends(get_session)) -> list[MessageOut]:
    c = db.get(Conversation, conversation_id)
    if c is None:
        raise HTTPException(404, "Conversation not found")
    rows = (
        db.query(Message)
        .filter(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
        .all()
    )
    return [MessageOut.model_validate(r) for r in rows]


@router.post("/{conversation_id}/messages")
async def send_message(
    conversation_id: str,
    body: MessageSendIn,
    db: Session = Depends(get_session),
):
    """Send a user message; stream the agent reply back via SSE.

    Events emitted (in addition to passthrough Dify events):
      - ylw.msg.user      after the user message is persisted
      - ylw.msg.delta     each token chunk in the agent reply
      - ylw.msg.finished  when the agent reply is fully persisted
      - ylw.msg.failed    on error
    """
    conv = db.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(404, "Conversation not found")
    cw = db.get(CachedWorkflow, conv.workflow_id)
    if cw is None:
        raise HTTPException(404, "Agent (workflow) gone")

    svc = ProviderService(db)
    provider = svc.get(cw.provider_id)
    if provider is None:
        raise HTTPException(404, "Provider for this agent is gone")

    mode = (provider.meta or {}).get("mode") or cw.kind or "chat"
    client = svc.make_client(provider)

    # Persist user message immediately so the UI can echo even if Dify fails.
    user_msg = Message(
        conversation_id=conversation_id,
        role="user",
        content=body.content,
        range_start=body.range_start,
        range_end=body.range_end,
    )
    db.add(user_msg)

    # Auto-generate title from first user message if title is empty.
    if not conv.title or conv.title == "新对话":
        conv.title = body.content[:50] + ("..." if len(body.content) > 50 else "")

    conv.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(user_msg)

    user_msg_payload = MessageOut.model_validate(user_msg).model_dump(mode="json")

    async def event_gen():
        yield {"event": "ylw.msg.user", "data": json.dumps(user_msg_payload)}

        agent_text_parts: list[str] = []
        external_msg_id = ""
        external_conv_id = conv.external_conversation_id

        try:
            async for evt in client.run_streaming(
                mode=mode,
                inputs=body.inputs,
                user=f"yuwanlab-conv-{conversation_id[:8]}",
                query=body.content,
                conversation_id=external_conv_id,
            ):
                kind = evt.get("event")
                if evt.get("conversation_id"):
                    external_conv_id = evt["conversation_id"]
                if evt.get("message_id"):
                    external_msg_id = evt["message_id"]
                if kind in ("message", "agent_message") and isinstance(evt.get("answer"), str):
                    delta = evt["answer"]
                    agent_text_parts.append(delta)
                    yield {
                        "event": "ylw.msg.delta",
                        "data": json.dumps({"delta": delta}),
                    }
                # Pass through other events for richer UIs (tool calls, etc.).
                yield {"event": "dify", "data": json.dumps(evt)}
        except DifyError as e:
            err = f"{e.status}: {e.detail}"
            agent_msg = Message(
                conversation_id=conversation_id,
                role="agent",
                content="".join(agent_text_parts),
                error=err,
                external_message_id=external_msg_id,
            )
            db.add(agent_msg)
            db.commit()
            yield {"event": "ylw.msg.failed", "data": json.dumps({"error": err})}
            return
        except Exception as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"[:512]
            agent_msg = Message(
                conversation_id=conversation_id,
                role="agent",
                content="".join(agent_text_parts),
                error=err,
                external_message_id=external_msg_id,
            )
            db.add(agent_msg)
            db.commit()
            yield {"event": "ylw.msg.failed", "data": json.dumps({"error": err})}
            return

        # Success: persist agent message + bump conversation.
        agent_msg = Message(
            conversation_id=conversation_id,
            role="agent",
            content="".join(agent_text_parts),
            external_message_id=external_msg_id,
        )
        db.add(agent_msg)
        if external_conv_id and external_conv_id != conv.external_conversation_id:
            conv.external_conversation_id = external_conv_id
        conv.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(agent_msg)

        yield {
            "event": "ylw.msg.finished",
            "data": json.dumps(MessageOut.model_validate(agent_msg).model_dump(mode="json")),
        }

    return EventSourceResponse(event_gen())

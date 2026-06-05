"""/api/conversations — chat-style discussions per (document, agent).

Each conversation maps 1:1 to a Dify conversation_id once it has at least one
message. We persist user/agent turns locally so the UI can rehydrate without
hitting Dify, and so the chat stays coherent if the Dify side resets.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import desc, func
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from ..database import get_session
from ..models import Conversation, Doc, Message, Project, User
from ..schemas import (
    BrowserCodexFinishIn,
    BrowserCodexPrepareOut,
    BrowserCodexToolIn,
    BrowserCodexToolOut,
    BrowserNanobotFinishIn,
    BrowserNanobotPrepareOut,
    BrowserNanobotToolIn,
    BrowserNanobotToolOut,
    ConversationCreateIn,
    ConversationOut,
    ConversationUpdateIn,
    MessageInjectIn,
    MessageOut,
    MessageSendIn,
)
from ..secrets_vault import decrypt
from ..services.agent_registry_service import AgentRegistryService, ResolvedAgent
from ..services.agent_workspace_service import AgentWorkspaceService
from ..services.attached_files import (
    collect_image_attachments,
    normalize_attached_files,
    render_attached_files_block,
)
from ..services.conversation_session_service import (
    conversation_session_messages_from_rows,
    delete_conversation_session,
    render_session_messages_for_prompt,
    write_conversation_session,
)
from ..services.dify_client import DifyError
from ..services.mcp_config_service import McpConfigService
from ..services.nanobot_client import NanobotError
from ..services.native_agent_runner import (
    NativeAgentRunner,
    NativeAgentRuntimeConfig,
    NativeRunPayload,
    browser_codex_system_prompt,
    browser_nanobot_system_prompt,
    browser_nanobot_tools,
)
from ..services.provider_service import ProviderService
from .deps import get_current_project, get_current_user

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


def _to_out(c: Conversation, *, message_count: int = 0, last_preview: str = "") -> ConversationOut:
    return ConversationOut(
        id=c.id,
        project_id=c.project_id,
        document_id=c.document_id,
        workflow_id=c.workflow_id,
        title=c.title,
        user_renamed=c.user_renamed,
        is_pinned=c.is_pinned,
        sort_index=c.sort_index,
        external_conversation_id=c.external_conversation_id,
        created_at=c.created_at,
        updated_at=c.updated_at,
        message_count=message_count,
        last_message_preview=last_preview,
    )


def _panel_reply_contract(
    *,
    doc_format: str = "",
    target_text: str = "",
    user_message: str = "",
) -> str:
    label, fence = _infer_source_format(
        doc_format=doc_format,
        sample=f"{target_text}\n{user_message}",
    )
    return "\n".join(
        [
            "[REPLY FORMAT]",
            "- 主要回答直接用 Markdown。",
            "- 不要输出 JSON，也不要把内容拆成 annotations/suggestions/risks 或多张批注。",
            f"- 如果给出可替换文本，只放在一个 fenced code block 中；代码块内容保持{label}源格式，围栏语言建议：{fence}.",
            "[END REPLY FORMAT]",
        ]
    )


def _infer_source_format(*, doc_format: str, sample: str) -> tuple[str, str]:
    if _looks_like_latex(sample):
        return " LaTeX ", "latex"
    if _looks_like_markdown(sample):
        return " Markdown ", "markdown"
    fmt = (doc_format or "").strip().lower()
    if fmt == "tex":
        return " LaTeX ", "latex"
    if fmt == "md":
        return " Markdown ", "markdown"
    return "纯文本", "text"


def _looks_like_latex(text: str) -> bool:
    return bool(
        re.search(
            r"\\(?:begin|end|section|subsection|subsubsection|paragraph|cite|ref|label|textbf|emph|item)\b",
            text,
        )
        or re.search(r"\\[a-zA-Z]+\s*\{", text)
        or re.search(r"\$(?:\\.|[^$\n])+\$", text)
    )


def _looks_like_markdown(text: str) -> bool:
    return bool(
        re.search(r"^#{1,6}\s+\S", text, re.M)
        or re.search(r"^>\s+\S", text, re.M)
        or re.search(r"^ {0,3}(?:[-*+]|\d+\.)\s+\S", text, re.M)
        or re.search(r"\[[^\]]+\]\([^)]+\)", text)
        or re.search(r"(?:^|\n)```", text)
        or re.search(r"\*\*[^*\n][\s\S]*?\*\*", text)
    )


def _resolve_agent(
    db: Session,
    workflow_id: str,
    *,
    project: Project,
    user: User,
    require_enabled: bool = True,
) -> ResolvedAgent | None:
    return AgentRegistryService(db).resolve(
        workflow_id,
        project_id=project.id,
        user_id=user.id,
        require_enabled=require_enabled,
    )


def _agent_name(resolved: ResolvedAgent) -> str:
    if resolved.native_agent is not None:
        return resolved.native_agent.name
    if resolved.cached_workflow is not None:
        return resolved.cached_workflow.name
    return resolved.workflow_id


def _provider_transport(provider: Any) -> str:
    return str((provider.meta or {}).get("transport") or "backend").strip() or "backend"


def _conversation_message_rows(db: Session, conversation_id: str) -> list[Message]:
    return (
        db.query(Message)
        .filter(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
        .all()
    )


def _sync_conversation_session(db: Session, conv: Conversation) -> None:
    write_conversation_session(conv, _conversation_message_rows(db, conv.id))


def _build_agent_query(
    db: Session,
    conv: Conversation,
    body: MessageSendIn,
    current_message_id: str | None = None,
) -> dict[str, Any]:
    history_rows = [
        row
        for row in _conversation_message_rows(db, conv.id)
        if row.id != current_message_id
    ]
    session_context = render_session_messages_for_prompt(
        conversation_session_messages_from_rows(history_rows)
    )

    target_text = str(body.inputs.get("target_text") or "").strip()
    before = str(body.inputs.get("before") or "").strip()
    after = str(body.inputs.get("after") or "").strip()
    section_title = str(body.inputs.get("section_title") or "").strip()
    document = db.get(Doc, conv.document_id)
    doc_format = str(body.inputs.get("doc_format") or getattr(document, "format", "") or "").strip()
    attached_files = normalize_attached_files(body.inputs.get("attached_files"))
    image_attachments = collect_image_attachments(attached_files)
    has_selection = bool(target_text) and (
        body.range_start is not None and body.range_end is not None
    )

    prompt_parts: list[str] = []
    if session_context:
        prompt_parts.append(session_context)

    prompt_parts.append(
        _panel_reply_contract(
            doc_format=doc_format,
            target_text=target_text,
            user_message=body.content,
        )
    )
    if document is not None:
        current_doc_parts = [
            "[CURRENT SUPERLEAF DOCUMENT]",
            f"doc_id: {document.id}",
            f"name: {document.name}",
            f"format: {document.format}",
            (
                "This is the document currently bound to the SuperLeaf editor conversation. "
                "When the user says current document, active document, this file, or the text in the editor, "
                f"use doc_id {document.id}. Do not assume the current document is main.tex unless this name says so."
            ),
            "[END CURRENT SUPERLEAF DOCUMENT]",
        ]
        prompt_parts.append("\n".join(current_doc_parts))

    if has_selection:
        context_parts: list[str] = ["[DISCUSSION CONTEXT]"]
        if section_title:
            context_parts.append(f"章节：{section_title}")
        context_parts.append(
            f"选区位置：文档偏移 {body.range_start}–{body.range_end}"
        )
        if before:
            context_parts.append(f"上文：\n{before}")
        context_parts.append(f"选中文本：\n{target_text}")
        if after:
            context_parts.append(f"下文：\n{after}")
        context_parts.append("[END DISCUSSION CONTEXT]")
        prompt_parts.append("\n\n".join(context_parts))

    attached_block = render_attached_files_block(attached_files)
    if attached_block:
        prompt_parts.append(attached_block)

    if prompt_parts:
        prompt_parts.append(f"[CURRENT USER MESSAGE]\n{body.content}")
        agent_query = "\n\n".join(prompt_parts)
    else:
        agent_query = body.content

    return {
        "agent_query": agent_query,
        "doc_format": doc_format,
        "attached_files": attached_files,
        "image_attachments": image_attachments,
    }


def _build_light_browser_codex_query(
    db: Session,
    conv: Conversation,
    body: MessageSendIn,
) -> dict[str, Any]:
    document = db.get(Doc, conv.document_id)
    target_text = str(body.inputs.get("target_text") or "").strip()
    before = str(body.inputs.get("before") or "").strip()
    after = str(body.inputs.get("after") or "").strip()
    section_title = str(body.inputs.get("section_title") or "").strip()
    doc_format = str(body.inputs.get("doc_format") or getattr(document, "format", "") or "").strip()
    attached_files = normalize_attached_files(body.inputs.get("attached_files"))
    image_attachments = collect_image_attachments(attached_files)

    parts = [
        "[SUPERLEAF QUICK CONTEXT]",
        "This is a lightweight SuperLeaf UI turn. Prefer a concise answer or one edit proposal.",
    ]
    if document is not None:
        parts.extend(
            [
                f"current_doc_id: {document.id}",
                f"current_doc_name: {document.name}",
                f"current_doc_format: {document.format}",
            ]
        )
    if section_title:
        parts.append(f"section: {section_title}")
    if body.range_start is not None and body.range_end is not None:
        parts.append(f"selection_range: {body.range_start}-{body.range_end}")
    if target_text:
        if before:
            parts.append(f"before_selection:\n{_clip_prompt_text(before, 2000)}")
        parts.append(f"selected_text:\n{_clip_prompt_text(target_text, 12000)}")
        if after:
            parts.append(f"after_selection:\n{_clip_prompt_text(after, 2000)}")
        parts.append(
            "If the user asks to rewrite, polish, translate, shorten, or modify this selection, "
            "request propose_doc_edit using original_text equal to selected_text, the provided "
            "selection_range, and the replacement text."
        )
    else:
        parts.append(
            "No selected text was provided. If exact document content is needed, request "
            "project_read_doc or project_grep through a SuperLeaf tool marker."
        )
    parts.append("[END SUPERLEAF QUICK CONTEXT]")

    attached_block = render_attached_files_block(attached_files)
    if attached_block:
        parts.append(_clip_prompt_text(attached_block, 6000))
    parts.append(
        _panel_reply_contract(
            doc_format=doc_format,
            target_text=target_text,
            user_message=body.content,
        )
    )
    parts.append(f"[CURRENT USER MESSAGE]\n{body.content}")
    return {
        "agent_query": "\n\n".join(parts),
        "doc_format": doc_format,
        "attached_files": attached_files,
        "image_attachments": image_attachments,
    }


def _clip_prompt_text(value: str, limit: int) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n[...trimmed {len(text) - limit} chars...]"


def _codex_settings_from_provider(provider: Any) -> dict[str, str]:
    meta = provider.meta or {}
    return {
        "model": str(meta.get("codex_model") or "").strip(),
        "effort": _codex_effort_choice(meta.get("codex_effort")),
        "summary": _settings_choice(meta.get("codex_summary"), {"none", "auto", "concise", "detailed"}, "none"),
        "service_tier": str(meta.get("codex_service_tier") or "").strip(),
        "sandbox": _settings_choice(meta.get("codex_sandbox"), {"read-only", "workspace-write", "danger-full-access"}, "read-only"),
        "approval_policy": _settings_choice(meta.get("codex_approval_policy"), {"never", "untrusted", "on-request", "on-failure"}, "never"),
        "prompt_mode": _settings_choice(meta.get("codex_prompt_mode"), {"fast-edit", "full-agent"}, "fast-edit"),
        "tool_mode": _settings_choice(meta.get("codex_tool_mode"), {"mcp-first", "browser-preflight", "marker-only"}, "mcp-first"),
    }


def _settings_choice(value: Any, allowed: set[str], default: str) -> str:
    cleaned = str(value or "").strip()
    return cleaned if cleaned in allowed else default


def _codex_effort_choice(value: Any) -> str:
    cleaned = str(value or "").strip()
    if cleaned == "minimal":
        return "low"
    return cleaned if cleaned in {"none", "low", "medium", "high", "xhigh"} else "low"


def _persist_user_message(
    db: Session,
    conv: Conversation,
    body: MessageSendIn,
) -> Message:
    user_msg = Message(
        conversation_id=conv.id,
        role="user",
        content=body.content,
        range_start=body.range_start,
        range_end=body.range_end,
    )
    db.add(user_msg)

    if not conv.user_renamed and (not conv.title or conv.title == "新对话"):
        conv.title = body.content[:50] + ("..." if len(body.content) > 50 else "")

    conv.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(user_msg)
    return user_msg


def _browser_nanobot_runner(
    *,
    provider: Any,
    project: Project,
    user: User,
    model: str,
) -> NativeAgentRunner:
    return NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id=f"browser-nanobot:{provider.id}",
            agent_name=provider.name,
            provider_endpoint=provider.endpoint,
            api_key="",
            model=model,
            instructions="",
            skills=[],
            workspace_root="",
            project_id=project.id,
            user_id=user.id,
        )
    )


def _browser_codex_runner(
    *,
    provider: Any,
    project: Project,
    user: User,
    model: str,
) -> NativeAgentRunner:
    return NativeAgentRunner(
        NativeAgentRuntimeConfig(
            agent_id=f"browser-codex:{provider.id}",
            agent_name=provider.name,
            provider_endpoint=provider.endpoint,
            api_key="",
            model=model,
            instructions="",
            skills=[],
            workspace_root="",
            project_id=project.id,
            user_id=user.id,
        )
    )


def _browser_tool_events(result: Any, call: dict[str, Any]) -> list[dict[str, Any]]:
    name = str((call.get("function") or {}).get("name") or "")
    events = [
        {
            "event": "native.agent.tool",
            "data": {
                "name": name,
                "result_preview": str(result.content)[:500],
                "failed": bool(result.failed),
                "tool_kind": result.tool_kind,
            },
        }
    ]
    if result.side_event:
        event = str(result.side_event.get("event") or "")
        data = result.side_event.get("data") or {}
        if event == "native.agent.edit_proposal":
            events.append({"event": "ylw.msg.edit_proposal", "data": data})
        elif event == "native.agent.suggestion_created":
            events.append({"event": "ylw.msg.suggestion_created", "data": data})
        else:
            events.append({"event": event, "data": data})
    return events


@router.get("", response_model=list[ConversationOut])
def list_conversations(
    document_id: str | None = None,
    workflow_id: str | None = None,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> list[ConversationOut]:
    q = db.query(Conversation).filter(
        Conversation.project_id == project.id,
        Conversation.user_id == user.id,
    )
    if document_id:
        q = q.filter(Conversation.document_id == document_id)
    if workflow_id:
        q = q.filter(Conversation.workflow_id == workflow_id)
    rows = q.all()
    rows.sort(
        key=lambda r: (
            1 if r.is_pinned else 0,
            r.sort_index if r.sort_index is not None else r.updated_at.timestamp(),
        ),
        reverse=True,
    )

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
    body: ConversationCreateIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> ConversationOut:
    resolved = _resolve_agent(db, body.workflow_id, project=project, user=user)
    if resolved is None:
        raise HTTPException(404, "Agent (workflow) not found")
    conv = Conversation(
        project_id=project.id,
        user_id=user.id,
        document_id=body.document_id,
        workflow_id=body.workflow_id,
        title=body.title or _agent_name(resolved),
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return _to_out(conv)


@router.get("/{conversation_id}", response_model=ConversationOut)
def get_conversation(
    conversation_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> ConversationOut:
    c = db.get(Conversation, conversation_id)
    if c is None or c.project_id != project.id or c.user_id != user.id:
        raise HTTPException(404, "Conversation not found")
    return _to_out(c)


@router.patch("/{conversation_id}", response_model=ConversationOut)
def update_conversation(
    conversation_id: str,
    body: ConversationUpdateIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> ConversationOut:
    c = db.get(Conversation, conversation_id)
    if c is None or c.project_id != project.id or c.user_id != user.id:
        raise HTTPException(404, "Conversation not found")
    if body.title is not None:
        c.title = body.title
        c.user_renamed = True
        c.updated_at = datetime.utcnow()
    if body.is_pinned is not None:
        c.is_pinned = body.is_pinned
    if body.clear_sort_index:
        c.sort_index = None
    elif body.sort_index is not None:
        c.sort_index = body.sort_index
    db.commit()
    db.refresh(c)
    return _to_out(c)


@router.delete("/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> None:
    c = db.get(Conversation, conversation_id)
    if c is None or c.project_id != project.id or c.user_id != user.id:
        return None
    db.query(Message).filter(Message.conversation_id == conversation_id).delete()
    db.delete(c)
    db.commit()
    delete_conversation_session(conversation_id)


@router.get("/{conversation_id}/messages", response_model=list[MessageOut])
def list_messages(
    conversation_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> list[MessageOut]:
    c = db.get(Conversation, conversation_id)
    if c is None or c.project_id != project.id or c.user_id != user.id:
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
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
):
    """Send a user message; stream the agent reply back via SSE.

    Events emitted (in addition to passthrough Dify events):
      - ylw.msg.user      after the user message is persisted
      - ylw.msg.delta     each token chunk in the agent reply
      - ylw.msg.finished  when the agent reply is fully persisted
      - ylw.msg.failed    on error
    """
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.project_id != project.id or conv.user_id != user.id:
        raise HTTPException(404, "Conversation not found")
    resolved = _resolve_agent(db, conv.workflow_id, project=project, user=user)
    if resolved is None:
        raise HTTPException(404, "Agent (workflow) gone")

    provider = resolved.provider
    cw = resolved.cached_workflow
    if resolved.source != "native" and cw is None:
        raise HTTPException(404, "Agent (workflow) gone")
    if (
        resolved.source != "native"
        and provider.kind == "nanobot"
        and _provider_transport(provider) == "browser"
    ):
        raise HTTPException(
            400,
            "Nanobot provider uses browser transport; call the browser Nanobot endpoints instead.",
        )
    if resolved.source != "native" and provider.kind == "codex-local":
        raise HTTPException(
            400,
            "Codex Local provider uses browser transport; call the browser Codex endpoints instead.",
        )
    client = ProviderService(db).make_client(provider) if resolved.source != "native" else None

    # Persist user message immediately so the UI can echo even if the provider fails.
    user_msg = _persist_user_message(db, conv, body)

    user_msg_payload = MessageOut.model_validate(user_msg).model_dump(mode="json")

    _sync_conversation_session(db, conv)
    prompt_payload = _build_agent_query(db, conv, body, current_message_id=user_msg.id)
    agent_query = str(prompt_payload["agent_query"])
    image_attachments = prompt_payload["image_attachments"]

    async def event_gen():
        yield {"event": "ylw.msg.user", "data": json.dumps(user_msg_payload)}

        agent_text_parts: list[str] = []
        external_msg_id = ""
        external_conv_id = conv.external_conversation_id

        try:
            if resolved.source == "native":
                agent = resolved.native_agent
                if agent is None:
                    raise TypeError("Native Agent resolution is missing agent row")
                native_conversation_id = external_conv_id or f"ylw-native-conv-{conversation_id}"
                native_inputs = dict(body.inputs or {})
                for prepared_key in (
                    "target_text",
                    "before",
                    "after",
                    "section_title",
                    "attached_files",
                ):
                    native_inputs.pop(prepared_key, None)
                native_inputs["instruction"] = agent_query
                skills = AgentRegistryService(db).skill_blocks_for_native_agent(agent, user_id=user.id)
                workspace_root = AgentWorkspaceService(db).ensure_workspace(agent)
                runtime_config = McpConfigService(db).resolve_runtime_config(
                    user_id=user.id,
                    runtime_config=agent.runtime_config or {},
                )
                runner = NativeAgentRunner(
                    NativeAgentRuntimeConfig(
                        agent_id=agent.id,
                        agent_name=agent.name,
                        provider_endpoint=provider.endpoint,
                        api_key=decrypt(provider.api_key_enc),
                        model=agent.model,
                        instructions=agent.instructions,
                        skills=skills,
                        workspace_root=str(workspace_root),
                        project_id=project.id,
                        user_id=user.id,
                        temperature=float(runtime_config.get("temperature", 0.2)),
                        max_tokens=int(runtime_config.get("max_tokens", 4000)),
                        runtime_config=runtime_config,
                    )
                )
                payload = NativeRunPayload(
                    document_id=conv.document_id,
                    range_start=body.range_start or 0,
                    range_end=body.range_end or 0,
                    inputs=native_inputs,
                    query="",
                    conversation_id=native_conversation_id,
                )
                async for evt in runner.stream(payload):
                    kind = str(evt.get("event") or "")
                    data = evt.get("data") or {}
                    if kind == "native.agent.output.delta" and isinstance(data, dict):
                        delta = data.get("delta")
                        if isinstance(delta, str):
                            agent_text_parts.append(delta)
                            yield {
                                "event": "ylw.msg.delta",
                                "data": json.dumps({"delta": delta}),
                            }
                    if kind == "native.agent.edit_proposal" and isinstance(data, dict):
                        yield {
                            "event": "ylw.msg.edit_proposal",
                            "data": json.dumps(data),
                        }
                    if kind == "native.agent.suggestion_created" and isinstance(data, dict):
                        yield {
                            "event": "ylw.msg.suggestion_created",
                            "data": json.dumps(data),
                        }
                    yield {"event": kind, "data": json.dumps(data)}
                external_conv_id = native_conversation_id
            elif provider.kind == "nanobot":
                from ..services.nanobot_client import NanobotClient
                if not isinstance(client, NanobotClient):
                    raise TypeError(f"Expected NanobotClient for nanobot provider, got {type(client)}")
                # Use session_id to let Nanobot manage conversation context
                session_id = f"ylw-{conversation_id}"
                if image_attachments:
                    user_content: list[dict[str, Any]] | str = [
                        {"type": "text", "text": agent_query},
                    ]
                    for img in image_attachments:
                        user_content.append(
                            {"type": "image_url", "image_url": {"url": img["url"]}}
                        )
                else:
                    user_content = agent_query
                async for evt in client.run_streaming(
                    model=cw.external_id,
                    messages=[{"role": "user", "content": user_content}],
                    session_id=session_id,
                ):
                    kind = evt.get("event")
                    # Extract text from OpenAI-style delta chunks
                    if "choices" in evt and evt["choices"]:
                        delta = evt["choices"][0].get("delta", {})
                        if "content" in delta:
                            text = delta["content"]
                            agent_text_parts.append(text)
                            yield {
                                "event": "ylw.msg.delta",
                                "data": json.dumps({"delta": text}),
                            }
                    # Pass through raw event
                    yield {"event": "nanobot", "data": json.dumps(evt)}
            else:
                from ..services.dify_client import DifyClient
                if not isinstance(client, DifyClient):
                    raise TypeError(f"Expected DifyClient for dify provider, got {type(client)}")
                mode = (provider.meta or {}).get("mode") or cw.kind or "chat"
                async for evt in client.run_streaming(
                    mode=mode,
                    inputs=body.inputs,
                    user=f"superleaf-conv-{conversation_id[:8]}",
                    query=agent_query,
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
        except (DifyError, NanobotError) as e:
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
            _sync_conversation_session(db, conv)
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
            _sync_conversation_session(db, conv)
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
        _sync_conversation_session(db, conv)

        yield {
            "event": "ylw.msg.finished",
            "data": json.dumps(MessageOut.model_validate(agent_msg).model_dump(mode="json")),
        }

    return EventSourceResponse(event_gen())


@router.post("/{conversation_id}/browser-codex/prepare", response_model=BrowserCodexPrepareOut)
def prepare_browser_codex_message(
    conversation_id: str,
    body: MessageSendIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> BrowserCodexPrepareOut:
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.project_id != project.id or conv.user_id != user.id:
        raise HTTPException(404, "Conversation not found")
    resolved = _resolve_agent(db, conv.workflow_id, project=project, user=user)
    if resolved is None or resolved.cached_workflow is None:
        raise HTTPException(404, "Agent (workflow) gone")
    provider = resolved.provider
    if provider.kind != "codex-local":
        raise HTTPException(400, "Conversation is not configured for browser Codex transport")

    user_msg = _persist_user_message(db, conv, body)
    _sync_conversation_session(db, conv)
    codex_settings = _codex_settings_from_provider(provider)
    prompt_payload = (
        _build_agent_query(db, conv, body, current_message_id=user_msg.id)
        if codex_settings["prompt_mode"] == "full-agent"
        else _build_light_browser_codex_query(db, conv, body)
    )
    run_id = f"browser-codex-{uuid.uuid4().hex}"
    workspace_path = str((provider.meta or {}).get("workspace_path") or "").strip()
    doc = db.get(Doc, conv.document_id)
    superleaf_context = {
        "project_id": project.id,
        "conversation_id": conversation_id,
        "document_id": conv.document_id,
        "document_name": doc.name if doc is not None else "",
        "document_format": doc.format if doc is not None else "",
        "range_start": body.range_start or 0,
        "range_end": body.range_end or 0,
        "provider_id": provider.id,
        "provider_name": provider.name,
    }
    return BrowserCodexPrepareOut(
        run_id=run_id,
        provider_id=provider.id,
        endpoint=provider.endpoint,
        model=codex_settings["model"] or resolved.cached_workflow.external_id or "codex",
        system_prompt=browser_codex_system_prompt(),
        prompt=str(prompt_payload["agent_query"]),
        tools=browser_nanobot_tools(),
        user_message=MessageOut.model_validate(user_msg),
        document_id=conv.document_id,
        range_start=body.range_start or 0,
        range_end=body.range_end or 0,
        workspace_path=workspace_path,
        prompt_mode=codex_settings["prompt_mode"],
        codex_settings=codex_settings,
        superleaf_context=superleaf_context,
        inputs=dict(body.inputs or {}),
    )


@router.post("/{conversation_id}/browser-codex/tool", response_model=BrowserCodexToolOut)
async def execute_browser_codex_tool(
    conversation_id: str,
    body: BrowserCodexToolIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> BrowserCodexToolOut:
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.project_id != project.id or conv.user_id != user.id:
        raise HTTPException(404, "Conversation not found")
    resolved = _resolve_agent(db, conv.workflow_id, project=project, user=user)
    if resolved is None or resolved.cached_workflow is None:
        raise HTTPException(404, "Agent (workflow) gone")
    provider = resolved.provider
    if provider.kind != "codex-local":
        raise HTTPException(400, "Conversation is not configured for browser Codex transport")

    payload = NativeRunPayload(
        document_id=body.document_id or conv.document_id,
        range_start=body.range_start,
        range_end=body.range_end,
        inputs=dict(body.inputs or {}),
        query="",
        conversation_id=body.run_id,
    )
    runner = _browser_codex_runner(
        provider=provider,
        project=project,
        user=user,
        model=resolved.cached_workflow.external_id or "codex",
    )
    result = await runner.execute_browser_superleaf_tool(
        body.tool_call,
        payload,
        tool_kind="browser_codex",
        surface_name="browser Codex",
    )
    call_id = str(body.tool_call.get("id") or "browser-tool-call")
    name = str((body.tool_call.get("function") or {}).get("name") or result.failed_function_name)
    return BrowserCodexToolOut(
        tool_call_id=call_id,
        content=result.content,
        failed=result.failed,
        name=name,
        tool_kind=result.tool_kind,
        events=_browser_tool_events(result, body.tool_call),
    )


@router.post("/{conversation_id}/browser-codex/finish", response_model=MessageOut, status_code=201)
def finish_browser_codex_message(
    conversation_id: str,
    body: BrowserCodexFinishIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> MessageOut:
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.project_id != project.id or conv.user_id != user.id:
        raise HTTPException(404, "Conversation not found")
    resolved = _resolve_agent(db, conv.workflow_id, project=project, user=user)
    if resolved is None or resolved.provider.kind != "codex-local":
        raise HTTPException(400, "Conversation is not configured for browser Codex transport")

    content = body.content.strip()
    error = body.error.strip()
    if not content and error:
        content = "Codex local run failed."
    if not content:
        content = "Codex returned no content."
    agent_msg = Message(
        conversation_id=conversation_id,
        role="agent",
        content=content,
        error=error,
        external_message_id=body.codex_session_id or body.run_id,
    )
    db.add(agent_msg)
    conv.external_conversation_id = body.codex_session_id or body.run_id
    conv.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(agent_msg)
    _sync_conversation_session(db, conv)
    return MessageOut.model_validate(agent_msg)


@router.post("/{conversation_id}/browser-nanobot/prepare", response_model=BrowserNanobotPrepareOut)
def prepare_browser_nanobot_message(
    conversation_id: str,
    body: MessageSendIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> BrowserNanobotPrepareOut:
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.project_id != project.id or conv.user_id != user.id:
        raise HTTPException(404, "Conversation not found")
    resolved = _resolve_agent(db, conv.workflow_id, project=project, user=user)
    if resolved is None or resolved.cached_workflow is None:
        raise HTTPException(404, "Agent (workflow) gone")
    provider = resolved.provider
    if provider.kind != "nanobot" or _provider_transport(provider) != "browser":
        raise HTTPException(400, "Conversation is not configured for browser Nanobot transport")

    user_msg = _persist_user_message(db, conv, body)
    _sync_conversation_session(db, conv)
    prompt_payload = _build_agent_query(db, conv, body, current_message_id=user_msg.id)
    model = resolved.cached_workflow.external_id
    run_id = f"browser-nanobot-{uuid.uuid4().hex}"
    return BrowserNanobotPrepareOut(
        run_id=run_id,
        provider_id=provider.id,
        endpoint=provider.endpoint,
        model=model,
        messages=[
            {"role": "system", "content": browser_nanobot_system_prompt()},
            {"role": "user", "content": str(prompt_payload["agent_query"])},
        ],
        tools=browser_nanobot_tools(),
        user_message=MessageOut.model_validate(user_msg),
        document_id=conv.document_id,
        range_start=body.range_start or 0,
        range_end=body.range_end or 0,
        inputs=dict(body.inputs or {}),
    )


@router.post("/{conversation_id}/browser-nanobot/tool", response_model=BrowserNanobotToolOut)
async def execute_browser_nanobot_tool(
    conversation_id: str,
    body: BrowserNanobotToolIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> BrowserNanobotToolOut:
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.project_id != project.id or conv.user_id != user.id:
        raise HTTPException(404, "Conversation not found")
    resolved = _resolve_agent(db, conv.workflow_id, project=project, user=user)
    if resolved is None or resolved.cached_workflow is None:
        raise HTTPException(404, "Agent (workflow) gone")
    provider = resolved.provider
    if provider.kind != "nanobot" or _provider_transport(provider) != "browser":
        raise HTTPException(400, "Conversation is not configured for browser Nanobot transport")

    payload = NativeRunPayload(
        document_id=body.document_id or conv.document_id,
        range_start=body.range_start,
        range_end=body.range_end,
        inputs=dict(body.inputs or {}),
        query="",
        conversation_id=body.run_id,
    )
    runner = _browser_nanobot_runner(
        provider=provider,
        project=project,
        user=user,
        model=resolved.cached_workflow.external_id,
    )
    result = await runner.execute_browser_nanobot_tool(body.tool_call, payload)
    call_id = str(body.tool_call.get("id") or "browser-tool-call")
    name = str((body.tool_call.get("function") or {}).get("name") or result.failed_function_name)
    return BrowserNanobotToolOut(
        tool_call_id=call_id,
        content=result.content,
        failed=result.failed,
        name=name,
        tool_kind=result.tool_kind,
        events=_browser_tool_events(result, body.tool_call),
    )


@router.post("/{conversation_id}/browser-nanobot/finish", response_model=MessageOut, status_code=201)
def finish_browser_nanobot_message(
    conversation_id: str,
    body: BrowserNanobotFinishIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> MessageOut:
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.project_id != project.id or conv.user_id != user.id:
        raise HTTPException(404, "Conversation not found")
    resolved = _resolve_agent(db, conv.workflow_id, project=project, user=user)
    if resolved is None or resolved.provider.kind != "nanobot" or _provider_transport(resolved.provider) != "browser":
        raise HTTPException(400, "Conversation is not configured for browser Nanobot transport")

    content = body.content.strip()
    error = body.error.strip()
    if not content and error:
        content = "Nanobot browser run failed."
    if not content:
        content = "Nanobot returned no content."
    agent_msg = Message(
        conversation_id=conversation_id,
        role="agent",
        content=content,
        error=error,
        external_message_id=body.run_id,
    )
    db.add(agent_msg)
    conv.external_conversation_id = body.run_id
    conv.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(agent_msg)
    _sync_conversation_session(db, conv)
    return MessageOut.model_validate(agent_msg)


@router.post("/{conversation_id}/messages/inject", response_model=MessageOut, status_code=201)
def inject_message(
    conversation_id: str,
    body: MessageInjectIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
    user: User = Depends(get_current_user),
) -> MessageOut:
    """Persist a pre-composed message without running the conversation's agent.

    Used by @workflow dispatches from the discussion surface: the orchestrator
    runs the workflow independently, and the caller wants to deposit the
    resulting summary into the conversation history so the chat stays a
    single, linear narrative.
    """
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.project_id != project.id or conv.user_id != user.id:
        raise HTTPException(404, "Conversation not found")

    msg = Message(
        conversation_id=conversation_id,
        role=body.role,
        content=body.content,
        range_start=body.range_start,
        range_end=body.range_end,
        error=body.error or "",
    )
    db.add(msg)
    conv.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(msg)
    rows = (
        db.query(Message)
        .filter(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
        .all()
    )
    write_conversation_session(conv, rows)
    return MessageOut.model_validate(msg)

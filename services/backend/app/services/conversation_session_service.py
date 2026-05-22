"""Nanobot-style session projection for discussion conversations.

The SQL Message table remains the canonical store. This module mirrors it into
JSONL session files so runtime prompts and future tools can consume one stable
session shape.
"""

from __future__ import annotations

from datetime import datetime
import json
import os
import re
from pathlib import Path
from typing import Any

from ..models import Conversation, Message
from ..settings import settings


def conversation_session_key(conversation_id: str) -> str:
    return f"conversation:{conversation_id}"


def conversation_session_path(conversation_id: str) -> Path:
    session_dir = settings.data_dir / "conversation_sessions"
    session_dir.mkdir(parents=True, exist_ok=True)
    return session_dir / f"{_safe_session_key(conversation_session_key(conversation_id))}.jsonl"


def conversation_session_messages_from_rows(messages: list[Message]) -> list[dict[str, Any]]:
    session_messages: list[dict[str, Any]] = []
    for message in messages:
        entry = conversation_message_to_session_entry(message)
        if entry is not None:
            session_messages.append(entry)
    return session_messages


def conversation_message_to_session_entry(message: Message) -> dict[str, Any] | None:
    content = str(message.content or "")
    if not content.strip() and not str(message.error or "").strip():
        return None

    role = "assistant" if message.role == "agent" else str(message.role or "user")
    metadata: dict[str, Any] = {
        "conversation_id": message.conversation_id,
    }
    if message.id:
        metadata["message_id"] = message.id
    if message.range_start is not None or message.range_end is not None:
        metadata["range_start"] = message.range_start
        metadata["range_end"] = message.range_end
    if message.error:
        metadata["error"] = message.error

    return {
        "role": role,
        "content": content,
        "timestamp": _iso_timestamp(message.created_at),
        "metadata": metadata,
    }


def render_session_messages_for_prompt(session_messages: list[dict[str, Any]]) -> str:
    if not session_messages:
        return ""

    parts: list[str] = ["[CONVERSATION SESSION]"]
    for message in session_messages:
        role = str(message.get("role") or "message")
        content = str(message.get("content") or "").strip()
        timestamp = str(message.get("timestamp") or "").strip()
        if not content:
            continue
        header = f"{role} ({timestamp}):" if timestamp else f"{role}:"
        parts.append(f"{header}\n{content}")
    if len(parts) == 1:
        return ""
    parts.append("[END CONVERSATION SESSION]")
    return "\n\n".join(parts)


def write_conversation_session(conversation: Conversation, messages: list[Message]) -> Path:
    path = conversation_session_path(conversation.id)
    tmp_path = path.with_suffix(".jsonl.tmp")
    payload = conversation_session_messages_from_rows(messages)

    metadata_line = {
        "_type": "metadata",
        "key": conversation_session_key(conversation.id),
        "conversation_id": conversation.id,
        "project_id": conversation.project_id,
        "user_id": conversation.user_id,
        "document_id": conversation.document_id,
        "workflow_id": conversation.workflow_id,
        "created_at": _iso_timestamp(conversation.created_at),
        "updated_at": _iso_timestamp(conversation.updated_at),
        "metadata": {
            "external_conversation_id": conversation.external_conversation_id,
        },
    }

    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(metadata_line, ensure_ascii=False) + "\n")
            for message in payload:
                f.write(json.dumps(message, ensure_ascii=False) + "\n")
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    return path


def delete_conversation_session(conversation_id: str) -> bool:
    path = conversation_session_path(conversation_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def _safe_session_key(key: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", key.strip())
    return cleaned.strip("._") or "conversation"


def _iso_timestamp(value: datetime | None) -> str:
    return (value or datetime.utcnow()).isoformat()

import json
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory

from app.models import Conversation, Message
from app.services.conversation_session_service import (
    conversation_session_messages_from_rows,
    render_session_messages_for_prompt,
    write_conversation_session,
)
from app.settings import settings


def _message(role: str, content: str, *, message_id: str = "msg1") -> Message:
    return Message(
        id=message_id,
        conversation_id="conv1",
        role=role,
        content=content,
        created_at=datetime(2026, 5, 21, 9, 0, 0),
    )


def test_conversation_session_maps_agent_role_to_assistant():
    messages = conversation_session_messages_from_rows(
        [
            _message("user", "please revise", message_id="msg-user"),
            _message("agent", "previous output", message_id="msg-agent"),
        ]
    )

    assert messages == [
        {
            "role": "user",
            "content": "please revise",
            "timestamp": "2026-05-21T09:00:00",
            "metadata": {
                "conversation_id": "conv1",
                "message_id": "msg-user",
            },
        },
        {
            "role": "assistant",
            "content": "previous output",
            "timestamp": "2026-05-21T09:00:00",
            "metadata": {
                "conversation_id": "conv1",
                "message_id": "msg-agent",
            },
        },
    ]


def test_session_prompt_renders_full_history_without_clipping():
    long_text = "x" * 5000
    block = render_session_messages_for_prompt(
        conversation_session_messages_from_rows([_message("agent", long_text)])
    )

    assert block.startswith("[CONVERSATION SESSION]")
    assert long_text in block
    assert "truncated" not in block
    assert block.endswith("[END CONVERSATION SESSION]")


def test_write_conversation_session_uses_nanobot_style_jsonl():
    old_data_dir = settings.data_dir
    with TemporaryDirectory() as tmp:
        settings.data_dir = Path(tmp)
        try:
            conversation = Conversation(
                id="conv1",
                project_id="proj1",
                user_id="user1",
                document_id="doc1",
                workflow_id="native:agent1",
                created_at=datetime(2026, 5, 21, 9, 0, 0),
                updated_at=datetime(2026, 5, 21, 9, 1, 0),
            )

            path = write_conversation_session(
                conversation,
                [
                    _message("user", "first", message_id="msg-user"),
                    _message("agent", "second", message_id="msg-agent"),
                ],
            )

            lines = path.read_text(encoding="utf-8").splitlines()
            metadata = json.loads(lines[0])
            first_message = json.loads(lines[1])
            second_message = json.loads(lines[2])

            assert metadata["_type"] == "metadata"
            assert metadata["key"] == "conversation:conv1"
            assert metadata["workflow_id"] == "native:agent1"
            assert first_message["role"] == "user"
            assert first_message["content"] == "first"
            assert second_message["role"] == "assistant"
            assert second_message["content"] == "second"
        finally:
            settings.data_dir = old_data_dir

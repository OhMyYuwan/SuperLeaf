from types import SimpleNamespace

from app.api.conversations import _browser_tool_visibility_envelope


def test_browser_tool_envelope_compacts_edit_proposal_for_model() -> None:
    result = SimpleNamespace(
        content='{"status":"proposed","original_text":"long ui payload"}',
        failed=False,
        failed_function_name="",
        tool_kind="edit_proposal",
        side_event={
            "event": "native.agent.edit_proposal",
            "data": {
                "proposal_id": "prop_1",
                "document_id": "doc_1",
                "original_text": "full original text",
                "new_text": "replacement",
            },
        },
    )
    call = {"id": "call_1", "function": {"name": "propose_doc_edit"}}

    envelope = _browser_tool_visibility_envelope(result, call)

    assert envelope["model_visible"]["summary"].startswith("Edit proposal created")
    assert envelope["model_visible"]["proposal_id"] == "prop_1"
    assert "full original text" not in envelope["content"]
    assert envelope["ui_meta"]["side_event"]["data"]["new_text"] == "replacement"
    assert envelope["audit"]["tool_call_id"] == "call_1"


def test_browser_tool_envelope_keeps_read_content_for_model() -> None:
    result = SimpleNamespace(
        content='{"doc_id":"doc_1","content":"paper text"}',
        failed=False,
        failed_function_name="",
        tool_kind="project_context",
        side_event=None,
    )
    call = {"id": "call_1", "function": {"name": "project_read_doc"}}

    envelope = _browser_tool_visibility_envelope(result, call)

    assert envelope["content"] == result.content
    assert envelope["model_visible"]["content"] == result.content

from pathlib import Path

from app.services.dify_client import DifyError
from app.services.nanobot_client import NanobotError
from app.services.secret_redaction import redact_secrets


ROOT = Path(__file__).resolve().parents[1]


def test_redact_secrets_removes_common_token_shapes() -> None:
    raw = (
        'Authorization: Bearer sk-live-1234567890 '
        '{"api_key":"app-secret-123","context_secret":"slctx_abcdef",'
        '"token":"slmcp_hidden","password":"pw-secret"} '
        "x-access-token:ghp_secret@example.test"
    )

    redacted = redact_secrets(raw)

    assert "sk-live-1234567890" not in redacted
    assert "app-secret-123" not in redacted
    assert "slctx_abcdef" not in redacted
    assert "slmcp_hidden" not in redacted
    assert "pw-secret" not in redacted
    assert "ghp_secret" not in redacted
    assert "[redacted]" in redacted


def test_provider_errors_store_and_render_redacted_detail() -> None:
    dify = DifyError(401, 'upstream said Authorization: Bearer app-dify-secret and api_key="raw-key"')
    nanobot = NanobotError(500, '{"token":"raw-token","error":"bad upstream"}')

    assert "app-dify-secret" not in dify.detail
    assert "raw-key" not in str(dify)
    assert "raw-token" not in nanobot.detail
    assert "raw-token" not in str(nanobot)
    assert "[redacted]" in str(dify)
    assert "[redacted]" in str(nanobot)


def test_workflow_sse_failures_emit_redacted_run_error() -> None:
    source = (ROOT / "app/api/workflows.py").read_text(encoding="utf-8")

    assert 'run.error = redact_secrets(f"{e.status}: {e.detail}")[:512]' in source
    assert "run.error = safe_error_text(e)" in source
    assert 'yield {"event": "ylw.run.failed", "data": json.dumps({"run_id": run.id, "error": run.error})}' in source
    assert 'json.dumps({"run_id": run.id, "error": str(e)' not in source
    assert 'json.dumps({"error": str(e)})' not in source


def test_conversation_routes_do_not_emit_multimodal_debug_logs() -> None:
    source = (ROOT / "app/api/conversations.py").read_text(encoding="utf-8")

    assert "[MULTIMODAL DEBUG]" not in source
    assert "print(" not in source

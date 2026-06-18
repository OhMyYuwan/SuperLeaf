from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
START_SH = (ROOT / "start.sh").read_text(encoding="utf-8")


def test_start_sh_does_not_put_internal_tokens_in_process_environment() -> None:
    assert "YLW_COLLAB_INTERNAL_TOKEN=$token_q" not in START_SH
    assert 'YLW_COLLAB_INTERNAL_TOKEN="$COLLAB_INTERNAL_TOKEN"' not in START_SH
    assert 'COLLAB_INTERNAL_TOKEN="$COLLAB_INTERNAL_TOKEN"' not in START_SH
    assert "SL_LOCAL_AGENT_HOST_AUTH_TOKEN=%q" not in START_SH
    assert 'SL_LOCAL_AGENT_HOST_AUTH_TOKEN="$LOCAL_AGENT_HOST_AUTH_TOKEN"' not in START_SH


def test_start_sh_uses_token_file_handoff_for_local_dev_services() -> None:
    assert "YLW_COLLAB_INTERNAL_TOKEN_FILE" in START_SH
    assert "COLLAB_INTERNAL_TOKEN_FILE" in START_SH
    assert "SL_LOCAL_AGENT_HOST_AUTH_TOKEN_FILE" in START_SH

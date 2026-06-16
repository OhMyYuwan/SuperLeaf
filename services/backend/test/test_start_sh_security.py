from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
START_SH = ROOT / "start.sh"
COLLAB_PERSISTENCE = ROOT / "services" / "collab-server" / "src" / "persistence.ts"


def test_start_sh_generates_collab_internal_token_without_fixed_default() -> None:
    text = START_SH.read_text(encoding="utf-8")

    assert (
        'COLLAB_INTERNAL_TOKEN="${YLW_COLLAB_INTERNAL_TOKEN:-${COLLAB_INTERNAL_TOKEN:-superleaf-local-collab-internal-token}}"'
        not in text
    )
    assert "generate_collab_internal_token()" in text
    assert 'COLLAB_INTERNAL_TOKEN="${YLW_COLLAB_INTERNAL_TOKEN:-${COLLAB_INTERNAL_TOKEN:-}}"' in text
    assert "Refusing historical fixed collab internal token" in text


def test_start_sh_binds_dev_collab_to_loopback_by_default() -> None:
    text = START_SH.read_text(encoding="utf-8")

    assert 'COLLAB_HOST="${YLW_COLLAB_HOST:-${COLLAB_HOST:-127.0.0.1}}"' in text
    assert 'COLLAB_HOST="$COLLAB_HOST"' in text


def test_collab_server_rejects_historical_default_internal_token() -> None:
    text = COLLAB_PERSISTENCE.read_text(encoding="utf-8")

    assert "HISTORICAL_DEFAULT_INTERNAL_TOKEN" in text
    expected_guard = (
        "const INTERNAL_TOKEN = RAW_INTERNAL_TOKEN === HISTORICAL_DEFAULT_INTERNAL_TOKEN "
        "? '' : RAW_INTERNAL_TOKEN"
    )
    assert expected_guard in text

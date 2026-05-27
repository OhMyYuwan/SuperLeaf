from app.services.collab_snapshot_service import _collab_internal_headers
from app.settings import settings


def test_collab_snapshot_sends_internal_token_header(monkeypatch):
    monkeypatch.setattr(settings, "collab_internal_token", "snapshot-secret")

    assert _collab_internal_headers() == {
        "X-SuperLeaf-Internal-Token": "snapshot-secret",
    }


def test_collab_snapshot_omits_blank_internal_token(monkeypatch):
    monkeypatch.setattr(settings, "collab_internal_token", "  ")

    assert _collab_internal_headers() == {}

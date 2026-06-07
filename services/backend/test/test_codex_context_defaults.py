from types import SimpleNamespace

from app.api.conversations import _codex_settings_from_provider
from app.services.provider_service import _codex_meta_patch


def test_codex_meta_patch_defaults_to_context_lease() -> None:
    patch = _codex_meta_patch(workspace_path="/tmp/project")

    assert patch["codex_context_mode"] == "lease"
    assert patch["codex_tool_mode"] == "mcp-first"


def test_codex_meta_patch_preserves_explicit_legacy_context() -> None:
    patch = _codex_meta_patch(
        workspace_path="/tmp/project",
        codex_context_mode="legacy-blocks",
    )

    assert patch["codex_context_mode"] == "legacy-blocks"


def test_codex_prepare_settings_default_to_context_lease() -> None:
    settings = _codex_settings_from_provider(SimpleNamespace(meta={}))

    assert settings["context_mode"] == "lease"
    assert settings["codex_context_mode"] == "lease"


def test_codex_prepare_settings_preserve_explicit_legacy_context() -> None:
    settings = _codex_settings_from_provider(
        SimpleNamespace(meta={"codex_context_mode": "legacy-blocks"})
    )

    assert settings["context_mode"] == "legacy-blocks"
    assert settings["codex_context_mode"] == "legacy-blocks"

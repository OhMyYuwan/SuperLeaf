from __future__ import annotations

from unittest.mock import Mock

import pytest

from app.services import skill_marketplace_service
from app.services.skill_marketplace_service import (
    MarketplaceEntry,
    SkillMarketplaceError,
    SkillMarketplaceService,
)


class TextResponse:
    def __init__(self, text: str) -> None:
        self.payload = text.encode()

    def __enter__(self) -> TextResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.payload


def test_skill_marketplace_rejects_absolute_loopback_entry_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog_url = "https://example.com/marketplace.json"
    private_url = "http://127.0.0.1:8765/private/SKILL.md"
    requested: list[str] = []

    def fake_urlopen(req, *, timeout: int) -> TextResponse:
        requested.append(req.full_url)
        if req.full_url == private_url:
            return TextResponse("# Private skill\n")
        raise AssertionError(f"unexpected URL: {req.full_url}")

    monkeypatch.setattr(skill_marketplace_service.urllib.request, "urlopen", fake_urlopen)

    service = SkillMarketplaceService(Mock(), catalog_url=catalog_url)
    with pytest.raises(SkillMarketplaceError, match="localhost|private|reserved"):
        service._fetch_text(private_url)

    assert requested == []


def test_skill_marketplace_rejects_absolute_private_readme_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog_url = "https://example.com/marketplace.json"
    private_url = "http://169.254.169.254/latest/meta-data"
    requested: list[str] = []

    def fake_urlopen(req, *, timeout: int) -> TextResponse:
        requested.append(req.full_url)
        if req.full_url == private_url:
            return TextResponse("instance secret")
        raise AssertionError(f"unexpected URL: {req.full_url}")

    monkeypatch.setattr(skill_marketplace_service.urllib.request, "urlopen", fake_urlopen)

    service = SkillMarketplaceService(Mock(), catalog_url=catalog_url)
    readme = service._clone_readme(
        _marketplace_entry(readme_url=private_url),
        local_name="Demo Skill",
    )

    assert requested == []
    assert readme.startswith("# Demo Skill")


def test_skill_marketplace_allows_relative_entry_under_catalog_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog_url = "https://example.com/marketplace.json"
    entry_url = "https://example.com/skills/demo/SKILL.md"
    requested: list[str] = []

    def fake_urlopen(req, *, timeout: int) -> TextResponse:
        requested.append(req.full_url)
        if req.full_url == entry_url:
            return TextResponse("# Demo skill\n")
        raise AssertionError(f"unexpected URL: {req.full_url}")

    monkeypatch.setattr(skill_marketplace_service.urllib.request, "urlopen", fake_urlopen)

    service = SkillMarketplaceService(Mock(), catalog_url=catalog_url)
    content = service._fetch_text("skills/demo/SKILL.md")

    assert content == "# Demo skill\n"
    assert requested == [entry_url]


def _marketplace_entry(**overrides: str) -> MarketplaceEntry:
    values = {
        "id": "demo",
        "name": "demo",
        "display_name": "Demo Skill",
        "version": "1.0.0",
        "author_github": "demo",
        "description": "Demo marketplace skill.",
        "tags": [],
        "license": "MIT",
        "path": "skills/demo",
        "entry": "SKILL.md",
        "skill_url": "skills/demo/skill.yaml",
        "entry_url": "skills/demo/SKILL.md",
        "readme_url": "",
        "checksum_sha256": "",
        "repo_url": "https://github.com/example/skills.git",
        "source_url": "https://github.com/example/skills/tree/main/skills/demo",
        "source_ref": "main",
        "skill_name": "demo",
        "install_command": (
            "npx --yes @codex/skills add https://github.com/example/skills.git "
            "--skill demo --agent codex --copy --yes"
        ),
    }
    values.update(overrides)
    return MarketplaceEntry(**values)

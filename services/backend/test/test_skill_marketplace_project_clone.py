from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import Doc, Project, Skill, User
from app.services.skill_marketplace_service import SkillMarketplaceService
from app.settings import settings


def _db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return session_factory()


def test_clone_marketplace_skill_creates_project_backed_local_skill(tmp_path, monkeypatch):
    old_data_dir = settings.data_dir
    settings.data_dir = tmp_path / "data"
    try:
        db = _db()
        user = User(id="user1", email="user@example.com", password_hash="hash")
        db.add(user)
        db.commit()

        raw_entry = {
            "id": "author@example-skill",
            "name": "Example Skill",
            "display_name": "Example Skill",
            "version": "1.2.3",
            "author_github": "author",
            "description": "Imported from the marketplace.",
            "tags": ["writing"],
            "path": "skills/example",
            "entry": "SKILL.md",
            "entry_url": "skills/example/SKILL.md",
            "readme_url": "skills/example/README.md",
            "repo_url": "https://github.com/example/skills.git",
            "source_ref": "main",
            "source_url": "https://github.com/example/skills/tree/main/skills/example",
        }

        svc = SkillMarketplaceService(db, catalog_url="https://example.test/marketplace.json")
        monkeypatch.setattr(svc, "_fetch_catalog", lambda: {"skills": [raw_entry]})
        monkeypatch.setattr(svc, "_fetch_external_catalog_entries", lambda: [])

        def fake_fetch_text(url_or_path: str) -> str:
            if url_or_path.endswith("SKILL.md"):
                return "# Example Skill\n\nUse the imported marketplace rules.\n"
            if url_or_path.endswith("README.md"):
                return "# Upstream Readme\n\nOriginal notes.\n"
            raise AssertionError(f"unexpected fetch: {url_or_path}")

        monkeypatch.setattr(svc, "_fetch_text", fake_fetch_text)

        installed, _ = svc.install("author@example-skill", user_id=user.id)
        cloned = svc.clone_to_local("author@example-skill", user_id=user.id, name="Example Skill Local")

        assert db.get(Skill, installed.id) is None
        assert cloned.source == "project"
        assert cloned.project_id
        assert cloned.cache_version == 1
        assert cloned.description == "Imported from the marketplace."
        assert "marketplace-copy" in cloned.tags
        assert "writing" in cloned.tags

        project = db.get(Project, cloned.project_id)
        assert project is not None
        assert project.is_skill_project is True
        assert project.name == "Example Skill Local"
        assert project.project_skill_id == cloned.id
        assert project.skill_cache_version == 1

        docs = {doc.name: doc for doc in db.query(Doc).filter_by(project_id=project.id).all()}
        assert sorted(docs) == ["README.md", "SKILL.md"]
        assert docs["SKILL.md"].content == "# Example Skill\n\nUse the imported marketplace rules.\n"
        assert "# Upstream Readme" in docs["README.md"].content
        assert "Marketplace ID: `author@example-skill`" in docs["README.md"].content

        cache_path = Path(cloned.cache_path)
        assert (cache_path / "SKILL.md").read_text() == docs["SKILL.md"].content
        assert (cache_path / "README.md").read_text() == docs["README.md"].content
    finally:
        settings.data_dir = old_data_dir

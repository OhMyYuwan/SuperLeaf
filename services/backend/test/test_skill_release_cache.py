from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import GitHubAccount, Skill, SkillRelease, User
from app.services.native_agent_service import NativeAgentService
from app.services.skill_content_crypto import encrypt_skill_content
from app.services.skill_marketplace_service import MarketplaceEntry, SkillMarketplaceService
from app.services.skill_release_cache_service import SkillReleaseCacheService


@pytest.fixture()
def db() -> Iterator[Session]:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_public_releases_allow_duplicate_display_names_with_distinct_namespaces(
    db: Session,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import skill_release_cache_service

    monkeypatch.setattr(skill_release_cache_service.settings, "data_dir", tmp_path)
    user = User(id="publisher", email="publisher@example.com", password_hash="hash")
    db.add(user)
    db.commit()

    source_a = _skill_folder(tmp_path / "a", name="reviewer", body="A")
    source_b = _skill_folder(tmp_path / "b", name="reviewer", body="B")
    svc = SkillReleaseCacheService(db)

    official = svc.publish_folder(
        namespace="official",
        slug="reviewer",
        version="1.0.0",
        display_name="Reviewer",
        visibility="public",
        source_dir=source_a,
        publisher_user_id="",
    )
    user_release = svc.publish_folder(
        namespace="publisher",
        slug="reviewer",
        version="1.0.0",
        display_name="Reviewer",
        visibility="public",
        source_dir=source_b,
        publisher_user_id=user.id,
    )

    assert official.display_name == user_release.display_name == "Reviewer"
    assert official.namespace == "official"
    assert user_release.namespace == "publisher"
    assert official.id != user_release.id
    assert official.artifact_checksum != user_release.artifact_checksum
    assert db.query(SkillRelease).count() == 2


def test_server_cache_reuses_content_addressed_artifact_path(
    db: Session,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import skill_release_cache_service

    monkeypatch.setattr(skill_release_cache_service.settings, "data_dir", tmp_path)
    source = _skill_folder(tmp_path / "source", name="copyedit", body="Same content")
    svc = SkillReleaseCacheService(db)

    first = svc.publish_folder(
        namespace="official",
        slug="copyedit",
        version="1.0.0",
        display_name="Copy Edit",
        visibility="public",
        source_dir=source,
    )
    second = svc.publish_folder(
        namespace="official",
        slug="copyedit",
        version="1.0.1",
        display_name="Copy Edit",
        visibility="public",
        source_dir=source,
    )

    assert first.artifact_checksum == second.artifact_checksum
    assert first.artifact_path == second.artifact_path
    assert (tmp_path / first.artifact_path).joinpath("SKILL.md").is_file()


def test_private_user_skill_ref_only_resolves_for_owner(
    db: Session,
    tmp_path,
) -> None:
    owner = User(id="owner", email="owner@example.com", password_hash="hash")
    other = User(id="other", email="other@example.com", password_hash="hash")
    cache = _skill_folder(tmp_path / "private-cache", name="private-skill", body="Private")
    skill = Skill(
        id="skill-owner",
        owner_user_id=owner.id,
        name="Private Skill",
        public_name="owner@private-skill",
        visibility="private",
        source="project",
        cache_path=str(cache),
        cache_version=1,
    )
    db.add_all([owner, other, skill])
    db.commit()

    svc = SkillReleaseCacheService(db)
    resolved = svc.resolve_skill_ref(user_id=owner.id, ref={"skill_id": skill.id, "alias": "reviewer"})

    assert resolved.alias == "reviewer"
    assert resolved.storage_scope == "user"
    assert resolved.target_path == cache

    with pytest.raises(ValueError, match="skill not available"):
        svc.resolve_skill_ref(user_id=other.id, ref={"skill_id": skill.id, "alias": "reviewer"})


def test_publishing_user_skill_creates_idempotent_public_release(
    db: Session,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import skill_release_cache_service

    monkeypatch.setattr(skill_release_cache_service.settings, "data_dir", tmp_path)
    user = User(id="publisher", email="publisher@example.com", password_hash="hash")
    account = GitHubAccount(user_id=user.id, github_user_id="1", login="alice")
    skill = Skill(
        id="skill-reviewer",
        owner_user_id=user.id,
        name="Reviewer",
        public_name="alice@reviewer",
        description="Review things",
        content=encrypt_skill_content("# Reviewer\n\nReview things.\n"),
        visibility="private",
        source="upload",
        version=3,
    )
    db.add_all([user, account, skill])
    db.commit()

    row = NativeAgentService(db).publish_skill(skill.id, user_id=user.id)
    again = NativeAgentService(db).publish_skill(skill.id, user_id=user.id)

    release = db.query(SkillRelease).filter_by(source_skill_id=skill.id).one()
    assert row is not None and again is not None
    assert release.namespace == "alice"
    assert release.slug == "reviewer"
    assert release.version == "3"
    assert release.visibility == "public"
    assert release.publisher_user_id == user.id
    assert (tmp_path / release.artifact_path / "SKILL.md").is_file()
    assert db.query(SkillRelease).filter_by(source_skill_id=skill.id).count() == 1


def test_marketplace_install_creates_official_server_release(
    db: Session,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import skill_release_cache_service

    monkeypatch.setattr(skill_release_cache_service.settings, "data_dir", tmp_path)
    user = User(id="installer", email="installer@example.com", password_hash="hash")
    db.add(user)
    db.commit()

    entry = MarketplaceEntry(
        id="openai/reviewer",
        name="reviewer",
        display_name="Reviewer",
        version="1.2.3",
        author_github="openai",
        description="Review things",
        tags=["review"],
        license="MIT",
        path="skills/reviewer",
        entry="SKILL.md",
        skill_url="https://example.test/skill.yaml",
        entry_url="https://example.test/SKILL.md",
        readme_url="",
        checksum_sha256="",
        repo_url="https://github.com/openai/skills",
        source_url="https://github.com/openai/skills",
        source_ref="main",
        skill_name="reviewer",
        install_command="npx --yes skills add https://github.com/openai/skills --skill reviewer",
    )
    svc = SkillMarketplaceService(db, catalog_url="https://example.test/marketplace.json")
    monkeypatch.setattr(svc, "_find_entry", lambda _skill_id, *, user_id: entry)
    monkeypatch.setattr(svc, "_fetch_text", lambda _url: "# Reviewer\n\nOfficial content.\n")

    row, installed = svc.install(entry.id, user_id=user.id)

    release = db.query(SkillRelease).filter_by(namespace="official-openai", slug="reviewer").one()
    assert row.id == installed.installed_skill_id
    assert release.version == "1.2.3"
    assert release.visibility == "public"
    assert release.source_type == "marketplace"
    assert "install_command" in release.install_spec
    assert (tmp_path / release.artifact_path / "SKILL.md").read_text(encoding="utf-8").startswith("# Reviewer")


def _skill_folder(path, *, name: str, body: str):
    path.mkdir(parents=True, exist_ok=True)
    (path / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name} description\n---\n# {name}\n\n{body}\n",
        encoding="utf-8",
    )
    return path

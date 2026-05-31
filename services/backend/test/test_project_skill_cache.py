from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import Doc, Folder, NativeAgentSkillInstall, Project, Provider, Skill, User
from app.services.agent_registry_service import AgentRegistryService
from app.services.native_agent_service import NativeAgentService
from app.settings import settings


def _db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return session_factory()


def _seed_project(db, *, name: str = "Security Paper Skill") -> tuple[User, Project]:
    user = User(id="user1", email="user@example.com", password_hash="hash")
    project = Project(id="proj1", user_id=user.id, name=name)
    refs = Folder(id="folder_refs", project_id=project.id, parent_folder_id=None, name="references")
    db.add_all(
        [
            user,
            project,
            refs,
            Doc(
                id="doc_skill",
                project_id=project.id,
                folder_id=None,
                name="SKILL.md",
                format="md",
                content="# Security Paper Skill\n\nUse the project rules.",
            ),
            Doc(
                id="doc_rules",
                project_id=project.id,
                folder_id=refs.id,
                name="writing-rules.md",
                format="md",
                content="Do not invent academic terms.",
            ),
        ]
    )
    db.commit()
    return user, project


def test_project_skill_cache_materializes_project_files_and_runtime_reads_cache(tmp_path):
    old_data_dir = settings.data_dir
    settings.data_dir = tmp_path / "data"
    try:
        db = _db()
        user, project = _seed_project(db)
        git_folder = Folder(id="folder_git", project_id=project.id, parent_folder_id=None, name=".git")
        db.add_all(
            [
                git_folder,
                Doc(
                    id="doc_git_config",
                    project_id=project.id,
                    folder_id=git_folder.id,
                    name="config",
                    format="txt",
                    content="should not be cached",
                ),
                Doc(
                    id="doc_dotdot",
                    project_id=project.id,
                    folder_id=None,
                    name="..",
                    format="txt",
                    content="safe path",
                ),
            ]
        )
        db.commit()

        skill = NativeAgentService(db).update_project_skill_cache(project, user_id=user.id)

        assert skill.source == "project"
        assert skill.project_id == project.id
        assert skill.cache_version == 1
        assert project.is_skill_project is True
        assert project.project_skill_id == skill.id

        cache_path = Path(skill.cache_path)
        assert (cache_path / "SKILL.md").read_text() == "# Security Paper Skill\n\nUse the project rules."
        assert (cache_path / "references" / "writing-rules.md").read_text() == "Do not invent academic terms."
        assert not (cache_path / ".git" / "config").exists()
        assert (cache_path / "untitled").read_text() == "safe path"

        agent = type("Agent", (), {"skill_ids": [skill.id]})()
        blocks = AgentRegistryService(db).skill_blocks_for_native_agent(agent, user_id=user.id)
        assert len(blocks) == 1
        assert "# Security Paper Skill" in blocks[0].content
        assert "[references/writing-rules.md]" in blocks[0].content
        assert "Do not invent academic terms." in blocks[0].content
    finally:
        settings.data_dir = old_data_dir


def test_project_skill_cache_unmarked_project_is_not_runtime_active(tmp_path):
    old_data_dir = settings.data_dir
    settings.data_dir = tmp_path / "data"
    try:
        db = _db()
        user, project = _seed_project(db)
        svc = NativeAgentService(db)
        skill = svc.update_project_skill_cache(project, user_id=user.id)

        project.is_skill_project = False
        db.add(project)
        db.commit()

        assert skill.id not in {row.id for row in svc.list_skills(user_id=user.id)}
        assert svc.get_skill(skill.id, user_id=user.id) is None
        agent = type("Agent", (), {"skill_ids": [skill.id]})()
        assert AgentRegistryService(db).skill_blocks_for_native_agent(agent, user_id=user.id) == []
    finally:
        settings.data_dir = old_data_dir


def test_project_skill_cache_update_reuses_skill_and_refreshes_content(tmp_path):
    old_data_dir = settings.data_dir
    settings.data_dir = tmp_path / "data"
    try:
        db = _db()
        user, project = _seed_project(db)
        svc = NativeAgentService(db)

        first = svc.update_project_skill_cache(project, user_id=user.id)
        doc = db.get(Doc, "doc_rules")
        doc.content = "Use only user-provided terminology."
        db.add(doc)
        db.commit()

        second = svc.update_project_skill_cache(project, user_id=user.id)

        assert second.id == first.id
        assert second.cache_version == 2
        assert Path(second.cache_path, "references", "writing-rules.md").read_text() == "Use only user-provided terminology."
    finally:
        settings.data_dir = old_data_dir


def test_project_skill_cache_requires_root_skill_md(tmp_path):
    old_data_dir = settings.data_dir
    settings.data_dir = tmp_path / "data"
    try:
        db = _db()
        user = User(id="user1", email="user@example.com", password_hash="hash")
        project = Project(id="proj1", user_id=user.id, name="No Skill")
        db.add_all([user, project])
        db.commit()

        with pytest.raises(ValueError, match="SKILL.md"):
            NativeAgentService(db).update_project_skill_cache(project, user_id=user.id)
    finally:
        settings.data_dir = old_data_dir


def test_project_skill_cache_name_conflict_gets_suffix_and_agent_install_uses_reference(tmp_path):
    old_data_dir = settings.data_dir
    settings.data_dir = tmp_path / "data"
    try:
        db = _db()
        user, project = _seed_project(db, name="Security Paper Skill")
        provider = Provider(
            id="provider1",
            user_id=user.id,
            name="Native",
            kind="native",
            endpoint="http://localhost",
        )
        existing = Skill(
            id="existing_skill",
            owner_user_id=user.id,
            name="Security Paper Skill",
            public_name="local@Security Paper Skill",
            content="",
            visibility="private",
            source="upload",
        )
        db.add_all([provider, existing])
        db.commit()

        svc = NativeAgentService(db)
        skill = svc.update_project_skill_cache(project, user_id=user.id)
        assert skill.public_name == "local@Security Paper Skill (1)"

        agent = svc.create_agent(
            project_id=project.id,
            user_id=user.id,
            name="Writer Agent",
            description="",
            provider_id=provider.id,
            model="gpt-test",
            instructions="Use selected skills.",
            skill_ids=[skill.id],
            output_contract="annotation",
            runtime_config={},
            is_enabled=True,
        )

        install = db.query(NativeAgentSkillInstall).filter_by(agent_id=agent.id, skill_id=skill.id).one()
        assert install.status == "installed"
        assert install.source == "project"
        assert install.install_command == "project Skill cache reference"
        assert Path(install.folder_path).name.endswith(".skillref.json")
        assert Path(install.folder_path).exists()
    finally:
        settings.data_dir = old_data_dir

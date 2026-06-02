from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import Doc, Folder, NativeAgentSkillInstall, Project, ProjectMember, Provider, Skill, User
from app.services.agent_registry_service import AgentRegistryService
from app.services.native_agent_service import NativeAgentService
from app.services.project_service import ProjectService
from app.settings import settings


def _db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return session_factory()


def _mock_agent_with_workspace(tmp_path: Path, cache_path: Path, *, folder_name: str = "security-paper-skill"):
    """Create a mock agent with workspace and a .skillref.json pointing to cache_path."""
    import json

    workspace = tmp_path / "workspace"
    skills_dir = workspace / ".agents" / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)
    ref_file = skills_dir / f"{folder_name}.skillref.json"
    ref_file.write_text(
        json.dumps({
            "type": "superleaf-skill-cache-ref",
            "folder_name": folder_name,
            "target_path": str(cache_path),
            "manifest": {},
        }, indent=2) + "\n",
        encoding="utf-8",
    )
    return type("Agent", (), {"skill_ids": [], "workspace_path": str(workspace)})()


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


def test_create_skill_project_seeds_readme_and_skill_md_only():
    db = _db()
    user = User(id="user1", email="user@example.com", password_hash="hash")
    db.add(user)
    db.commit()

    project = ProjectService(db).create(user_id=user.id, name="Security Skill", project_type="skill")
    docs = db.query(Doc).filter_by(project_id=project.id).order_by(Doc.name.asc()).all()

    assert project.is_skill_project is True
    assert [doc.name for doc in docs] == ["README.md", "SKILL.md"]
    assert project.main_doc_id == docs[0].id
    assert "metadata" not in {doc.name.lower() for doc in docs}
    assert "version:" in next(doc.content for doc in docs if doc.name == "SKILL.md")


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

        agent = _mock_agent_with_workspace(tmp_path, cache_path)
        blocks = AgentRegistryService(db).skill_blocks_for_native_agent(agent, user_id=user.id)
        assert len(blocks) == 1
        assert blocks[0].name == "security-paper-skill"
        assert blocks[0].source == "project"
        assert blocks[0].folder_path == "skills/security-paper-skill.skillref.json"
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
        # In the new model, disk-based skills are found regardless of DB state.
        # The .skillref.json still points to a valid cache, so the scanner finds it.
        agent = _mock_agent_with_workspace(tmp_path, Path(skill.cache_path))
        blocks = AgentRegistryService(db).skill_blocks_for_native_agent(agent, user_id=user.id)
        assert len(blocks) == 1  # found on disk
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


def test_delete_project_skill_keeps_project_and_allows_cache_recreate(tmp_path):
    old_data_dir = settings.data_dir
    settings.data_dir = tmp_path / "data"
    try:
        db = _db()
        user, project = _seed_project(db)
        svc = NativeAgentService(db)

        first = svc.update_project_skill_cache(project, user_id=user.id)
        first_cache_path = Path(first.cache_path)
        assert first_cache_path.exists()

        assert svc.delete_skill(first.id, user_id=user.id) is True
        db.refresh(project)

        assert db.get(Project, project.id) is not None
        assert db.get(Skill, first.id) is None
        assert project.is_skill_project is True
        assert project.project_skill_id == ""
        assert project.skill_cache_version == 0
        assert project.skill_cache_updated_at is None
        assert not first_cache_path.exists()

        recreated = svc.update_project_skill_cache(project, user_id=user.id)

        assert recreated.id != first.id
        assert recreated.source == "project"
        assert recreated.project_id == project.id
        assert project.project_skill_id == recreated.id
        assert (
            Path(recreated.cache_path, "SKILL.md").read_text()
            == "# Security Paper Skill\n\nUse the project rules."
        )
    finally:
        settings.data_dir = old_data_dir


def test_project_skill_is_available_to_project_collaborators(tmp_path):
    old_data_dir = settings.data_dir
    settings.data_dir = tmp_path / "data"
    try:
        db = _db()
        owner, project = _seed_project(db)
        editor = User(id="editor", email="editor@example.com", password_hash="hash")
        viewer = User(id="viewer", email="viewer@example.com", password_hash="hash")
        db.add_all(
            [
                editor,
                viewer,
                ProjectMember(project_id=project.id, user_id=editor.id, role="editor", status="accepted"),
                ProjectMember(project_id=project.id, user_id=viewer.id, role="viewer", status="accepted"),
            ]
        )
        db.commit()

        svc = NativeAgentService(db)
        skill = svc.update_project_skill_cache(project, user_id=owner.id)

        assert skill.id in {row.id for row in svc.list_skills(user_id=editor.id)}
        assert skill.id in {row.id for row in svc.list_skills(user_id=viewer.id)}
        assert svc.get_skill(skill.id, user_id=editor.id) is not None

        agent = _mock_agent_with_workspace(tmp_path, Path(skill.cache_path))
        blocks = AgentRegistryService(db).skill_blocks_for_native_agent(agent, user_id=editor.id)
        assert len(blocks) == 1
        assert blocks[0].source == "project"

        doc = db.get(Doc, "doc_rules")
        doc.content = "Shared editor refreshed this Skill."
        db.add(doc)
        db.commit()

        refreshed = svc.update_project_skill_cache(project, user_id=editor.id)
        assert refreshed.id == skill.id
        assert Path(refreshed.cache_path, "references", "writing-rules.md").read_text() == (
            "Shared editor refreshed this Skill."
        )

        with pytest.raises(ValueError, match="Project not found"):
            svc.update_project_skill_cache(project, user_id=viewer.id)
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

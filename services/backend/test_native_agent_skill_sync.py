from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import NativeAgentSkillInstall, Project, Provider, Skill, User
from app.services.native_agent_service import NativeAgentService
from app.services.skill_content_crypto import encrypt_skill_content
from app.settings import settings


def test_native_agent_skill_deselection_removes_workspace_folder_and_install_row(tmp_path):
    old_data_dir = settings.data_dir
    settings.data_dir = tmp_path / "data"
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    try:
        engine = create_engine("sqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        db = session_factory()

        user = User(id="user1", email="user@example.com", password_hash="hash")
        project = Project(id="proj1", user_id=user.id, name="Project")
        provider = Provider(
            id="provider1",
            user_id=user.id,
            name="Native",
            kind="native",
            endpoint="http://localhost",
        )
        alpha = Skill(
            id="skill_alpha",
            owner_user_id=user.id,
            name="Alpha Skill",
            public_name="tester@alpha-skill",
            content=encrypt_skill_content("# Alpha Skill\n\nUse alpha.\n"),
            visibility="private",
            source="upload",
        )
        beta = Skill(
            id="skill_beta",
            owner_user_id=user.id,
            name="Beta Skill",
            public_name="tester@beta-skill",
            content=encrypt_skill_content("# Beta Skill\n\nUse beta.\n"),
            visibility="private",
            source="upload",
        )
        db.add_all([user, project, provider, alpha, beta])
        db.commit()

        svc = NativeAgentService(db)
        agent = svc.create_agent(
            project_id=project.id,
            user_id=user.id,
            name="Writer Agent",
            description="",
            provider_id=provider.id,
            model="gpt-test",
            instructions="Use selected skills.",
            skill_ids=[alpha.id, beta.id],
            output_contract="annotation",
            runtime_config={},
            is_enabled=True,
        )

        workspace = Path(agent.workspace_path)
        alpha_dir = workspace / ".agents" / "skills" / alpha.public_name
        beta_dir = workspace / ".agents" / "skills" / beta.public_name
        assert (alpha_dir / "SKILL.md").exists()
        assert (beta_dir / "SKILL.md").exists()

        beta_install = db.query(NativeAgentSkillInstall).filter_by(skill_id=beta.id).one()
        beta_install.skill_id = ""
        db.add(beta_install)
        db.commit()

        updated = svc.update_agent(
            agent.id,
            project_id=project.id,
            user_id=user.id,
            patch={"skill_ids": [alpha.id]},
        )

        assert updated is not None
        assert updated.skill_ids == [alpha.id]
        assert (alpha_dir / "SKILL.md").exists()
        assert not beta_dir.exists()
        installs = db.query(NativeAgentSkillInstall).filter_by(agent_id=agent.id).all()
        assert [(row.skill_id, row.status) for row in installs] == [(alpha.id, "installed")]

        updated = svc.update_agent(
            agent.id,
            project_id=project.id,
            user_id=user.id,
            patch={"skill_ids": []},
        )

        assert updated is not None
        assert updated.skill_ids == []
        assert not alpha_dir.exists()
        assert db.query(NativeAgentSkillInstall).filter_by(agent_id=agent.id).count() == 0
    finally:
        settings.data_dir = old_data_dir

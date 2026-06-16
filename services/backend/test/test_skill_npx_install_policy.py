from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import native_agents
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import NativeAgent, NativeAgentSkillInstall, Project, Provider, User
from app.services.skill_npx_installer import (
    SkillInstallResult,
    SkillNpxInstaller,
    SkillNpxInstallError,
    _parse_npx_install_command,
)
from app.settings import settings


@dataclass(slots=True)
class SeedData:
    owner: User
    project: Project
    provider: Provider
    agent: NativeAgent


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


@pytest.fixture()
def seed(db: Session) -> SeedData:
    owner = User(id="owner", email="owner@example.com", password_hash="hash", display_name="Owner")
    project = Project(id="project-a", user_id=owner.id, name="Project A")
    provider = Provider(
        id="provider-a",
        user_id=owner.id,
        name="Native",
        kind="native",
        endpoint="http://127.0.0.1:1",
    )
    agent = NativeAgent(
        id="agent-a",
        project_id=project.id,
        owner_user_id=owner.id,
        provider_id=provider.id,
        name="Agent A",
        instructions="Test",
        agent_md="Test",
    )
    db.add_all([owner, project, provider, agent])
    db.commit()
    return SeedData(owner=owner, project=project, provider=provider, agent=agent)


@pytest.fixture()
def owner_client(
    db: Session,
    seed: SeedData,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[TestClient]:
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    app = FastAPI()
    app.include_router(native_agents.router)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return seed.owner

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    with TestClient(app) as client:
        yield client


def test_direct_recipe_install_returns_403_when_npx_policy_disabled(
    db: Session,
    seed: SeedData,
    owner_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_npx_policy(monkeypatch, enabled=False)
    monkeypatch.setattr(SkillNpxInstaller, "install", _fake_install)

    response = owner_client.post(
        "/api/native-agent/agents/agent-a/skills/install-npx",
        headers={"X-Project-Id": seed.project.id},
        json=_recipe_payload(),
    )

    assert response.status_code == 403
    assert db.query(NativeAgentSkillInstall).count() == 0


def test_create_agent_with_recipe_returns_403_when_npx_policy_disabled(
    db: Session,
    seed: SeedData,
    owner_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_npx_policy(monkeypatch, enabled=False)
    monkeypatch.setattr(SkillNpxInstaller, "install", _fake_install)

    response = owner_client.post(
        "/api/native-agent/agents",
        headers={"X-Project-Id": seed.project.id},
        json={
            "name": "Agent With Recipe",
            "provider_id": seed.provider.id,
            "model": "local-model",
            "instructions": "Test",
            "skill_recipes": [_recipe_payload()],
        },
    )

    assert response.status_code == 403
    assert db.query(NativeAgent).filter(NativeAgent.name == "Agent With Recipe").first() is None
    assert db.query(NativeAgentSkillInstall).count() == 0


def test_direct_recipe_install_reaches_installer_when_npx_policy_enabled(
    seed: SeedData,
    owner_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_npx_policy(monkeypatch, enabled=True)
    seed.owner.is_admin = True
    calls: list[str] = []

    def fake_install(self: SkillNpxInstaller, agent: NativeAgent, recipe) -> SkillInstallResult:
        del self
        calls.append(agent.id)
        return _fake_install_result()

    monkeypatch.setattr(SkillNpxInstaller, "install", fake_install)

    response = owner_client.post(
        "/api/native-agent/agents/agent-a/skills/install-npx",
        headers={"X-Project-Id": seed.project.id},
        json=_recipe_payload(),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "installed"
    assert body["folder_name"] == "demo-skill"
    assert calls == ["agent-a"]


def test_direct_recipe_install_requires_admin_when_npx_policy_enabled(
    db: Session,
    seed: SeedData,
    owner_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_npx_policy(monkeypatch, enabled=True)
    monkeypatch.setattr(SkillNpxInstaller, "install", _fake_install)

    response = owner_client.post(
        "/api/native-agent/agents/agent-a/skills/install-npx",
        headers={"X-Project-Id": seed.project.id},
        json=_recipe_payload(),
    )

    assert response.status_code == 403
    assert db.query(NativeAgentSkillInstall).count() == 0


def test_create_agent_with_recipe_requires_admin_when_npx_policy_enabled(
    db: Session,
    seed: SeedData,
    owner_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_npx_policy(monkeypatch, enabled=True)
    monkeypatch.setattr(SkillNpxInstaller, "install", _fake_install)

    response = owner_client.post(
        "/api/native-agent/agents",
        headers={"X-Project-Id": seed.project.id},
        json={
            "name": "Agent With Recipe",
            "provider_id": seed.provider.id,
            "model": "local-model",
            "instructions": "Test",
            "skill_recipes": [_recipe_payload()],
        },
    )

    assert response.status_code == 403
    assert db.query(NativeAgent).filter(NativeAgent.name == "Agent With Recipe").first() is None
    assert db.query(NativeAgentSkillInstall).count() == 0


@pytest.mark.parametrize(
    "command",
    [
        "npx --package attacker-package skills add https://github.com/example/skills --skill demo-skill",
        "npx -p attacker-package skills add https://github.com/example/skills --skill demo-skill",
        "npx --call 'echo pwned' skills add https://github.com/example/skills --skill demo-skill",
        "npx --node-options=--inspect skills add https://github.com/example/skills --skill demo-skill",
    ],
)
def test_install_command_rejects_npx_execution_flags(command: str) -> None:
    with pytest.raises(SkillNpxInstallError):
        _parse_npx_install_command(command)


def _recipe_payload() -> dict[str, str]:
    return {
        "source": "custom",
        "repo_url": "https://github.com/example/skills",
        "skill_name": "demo-skill",
    }


def _set_npx_policy(monkeypatch: pytest.MonkeyPatch, *, enabled: bool) -> None:
    monkeypatch.setitem(settings.__dict__, "skill_npx_install_enabled", enabled)


def _fake_install(self: SkillNpxInstaller, agent: NativeAgent, recipe) -> SkillInstallResult:
    del self, agent, recipe
    return _fake_install_result()


def _fake_install_result() -> SkillInstallResult:
    return SkillInstallResult(
        folder_name="demo-skill",
        folder_path="/tmp/demo-skill",
        manifest={"files": [{"path": "SKILL.md", "size": 12}], "file_count": 1},
        install_command="npx --yes skills add https://github.com/example/skills --skill demo-skill",
        log="Installed successfully.",
    )

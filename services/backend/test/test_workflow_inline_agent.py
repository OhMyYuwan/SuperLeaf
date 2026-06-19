from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import workflows
from app.database import Base
from app.models import CachedWorkflow, NativeMcpServer, Project, Provider, SkillRelease, User, WorkflowDefinition, WorkflowRun
from app.services import agent_orchestrator, agent_workspace_service, skill_release_cache_service
from app.services.agent_orchestrator import NodeContext, OrchestrationContext, WorkflowOrchestrator
from app.services.agent_workspace_service import AgentWorkspaceService
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


def test_inline_agent_health_uses_workflow_provider_and_user_scope(db: Session) -> None:
    owner = User(id="owner", email="owner@example.com", password_hash="hash")
    runner = User(id="runner", email="runner@example.com", password_hash="hash")
    project = Project(id="project-runner", user_id=runner.id, name="Runner Project")
    foreign_provider = Provider(
        id="provider-owner",
        user_id=owner.id,
        name="Owner Provider",
        kind="native",
        endpoint="https://owner-provider.example.com",
    )
    runner_provider = Provider(
        id="provider-runner",
        user_id=runner.id,
        name="Runner Provider",
        kind="native",
        endpoint="https://runner-provider.example.com",
    )
    wf = WorkflowDefinition(
        id="definition-runner",
        project_id=project.id,
        user_id=runner.id,
        name="Inline Agent Workflow",
        execution_mode="graph",
        graph={
            "nodes": [
                {"id": "input", "type": "input"},
                {
                    "id": "draft",
                    "type": "agent",
                    "config": {"agent_source": "inline", "instructions": "Draft."},
                },
                {"id": "output", "type": "output"},
            ],
            "edges": [],
        },
        config={"provider": {"provider_id": foreign_provider.id}},
    )
    db.add_all([owner, runner, project, foreign_provider, runner_provider, wf])
    db.commit()

    issues = workflows._collect_unhealthy_agents(
        wf,
        db,
        project_id=project.id,
        user_id=runner.id,
    )

    assert issues == [
        {
            "node_id": "draft",
            "agent_id": "",
            "provider_id": "provider-owner",
            "reason": "provider_missing",
        }
    ]

    wf.config = {"provider": {"provider_id": runner_provider.id}}
    db.commit()

    assert workflows._collect_unhealthy_agents(wf, db, project_id=project.id, user_id=runner.id) == []


@pytest.mark.asyncio()
async def test_inline_agent_execution_reuses_native_runtime_config(
    db: Session,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_workspace_service.settings, "data_dir", tmp_path)
    monkeypatch.setattr(agent_orchestrator, "decrypt", lambda _cipher: "api-key")
    monkeypatch.setattr(
        agent_orchestrator.ProviderService,
        "ensure_backend_endpoint_allowed",
        lambda _self, provider: provider.endpoint,
    )

    captured: dict[str, object] = {}

    class FakeNativeAgentRunner:
        def __init__(self, config) -> None:
            self.config = config
            captured["config"] = config

        def prompt_audit_payload(self, payload) -> dict:
            captured["payload"] = payload
            return {"message_count": len(payload.prior_messages) + 2}

        async def stream(self, payload) -> AsyncIterator[dict]:
            captured["stream_payload"] = payload
            yield {
                "event": "native.agent.step",
                "data": {"agent_id": self.config.agent_id if hasattr(self, "config") else "unused"},
            }
            yield {"event": "native.agent.output.delta", "data": {"delta": "inline ok"}}

    monkeypatch.setattr(agent_orchestrator, "NativeAgentRunner", FakeNativeAgentRunner)

    user = User(id="runner", email="runner@example.com", password_hash="hash")
    project = Project(id="project-runner", user_id=user.id, name="Runner Project")
    provider = Provider(
        id="provider-runner",
        user_id=user.id,
        name="Runner Provider",
        kind="native",
        endpoint="https://runner-provider.example.com",
        api_key_enc="encrypted",
    )
    mcp_server = NativeMcpServer(
        id="mcp-runner",
        user_id=user.id,
        name="Runner MCP",
        transport="remote",
        command="https://mcp.example.com/mcp",
        allowed_tools=["search"],
        is_enabled=True,
    )
    cached = CachedWorkflow(
        id="workflow-placeholder",
        user_id=user.id,
        provider_id=provider.id,
        external_id="placeholder",
        name="Placeholder",
        kind="agent",
    )
    wf = WorkflowDefinition(
        id="definition-runner",
        project_id=project.id,
        user_id=user.id,
        name="Inline Agent Workflow",
        execution_mode="graph",
        graph={"nodes": [], "edges": []},
        config={
            "provider": {
                "provider_id": provider.id,
                "model": "workflow-model",
                "temperature": 0.4,
                "max_tokens": 777,
            }
        },
    )
    run = WorkflowRun(
        id="run-inline",
        project_id=project.id,
        user_id=user.id,
        provider_id=provider.id,
        workflow_id=cached.id,
        workflow_definition_id=wf.id,
        document_id="doc-runner",
        range_start=0,
        range_end=10,
        status="running",
        trace=[],
    )
    db.add_all([user, project, provider, mcp_server, cached, wf, run])
    db.commit()

    workspace = AgentWorkspaceService(db).ensure_project_workspace(project_id=project.id, user_id=user.id)
    skill_dir = workspace / ".agents" / "skills" / "inline-writer"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: inline-writer\ndescription: Inline writer skill\n---\n# Inline writer\n",
        encoding="utf-8",
    )

    node = NodeContext(
        node_id="draft",
        node_type="agent",
        config={
            "agent_source": "inline",
            "inline_agent": True,
            "instructions": "Write a concise draft.",
            "skill_names": ["inline-writer"],
            "runtime_config": {"mcp_server_ids": [mcp_server.id]},
        },
        inputs={"prior_messages": [{"role": "user", "content": "Please draft."}]},
    )
    ctx = OrchestrationContext(
        workflow_def=wf,
        workflow_run=run,
        document_id="doc-runner",
        target_text="selected text",
        target_range={"from": 0, "to": 10},
        user_instruction="Please draft.",
        db=db,
        nodes={"draft": node},
        context_files=[],
        all_outputs=[],
        chat_log=[],
    )

    output = await WorkflowOrchestrator(db)._execute_agent_node(ctx, "draft")

    config = captured["config"]
    assert output["text"] == "inline ok"
    assert output["agent_source"] == "inline"
    assert config.agent_id == "inline:draft"
    assert config.model == "workflow-model"
    assert config.temperature == 0.4
    assert config.max_tokens == 777
    assert [skill.name for skill in config.skills] == ["inline-writer"]
    assert config.runtime_config["mcp_server_ids"] == ["mcp-runner"]
    assert config.runtime_config["mcp_servers"][0]["id"] == "mcp-runner"


@pytest.mark.asyncio()
async def test_inline_agent_execution_projects_release_skills_to_node_workspace(
    db: Session,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_workspace_service.settings, "data_dir", tmp_path)
    monkeypatch.setattr(skill_release_cache_service.settings, "data_dir", tmp_path)
    monkeypatch.setattr(agent_orchestrator, "decrypt", lambda _cipher: "api-key")
    monkeypatch.setattr(
        agent_orchestrator.ProviderService,
        "ensure_backend_endpoint_allowed",
        lambda _self, provider: provider.endpoint,
    )

    captured: dict[str, object] = {}

    class FakeNativeAgentRunner:
        def __init__(self, config) -> None:
            captured["config"] = config

        def prompt_audit_payload(self, payload) -> dict:
            return {"message_count": len(payload.prior_messages) + 2}

        async def stream(self, payload) -> AsyncIterator[dict]:
            yield {"event": "native.agent.output.delta", "data": {"delta": "release skill ok"}}

    monkeypatch.setattr(agent_orchestrator, "NativeAgentRunner", FakeNativeAgentRunner)

    user = User(id="runner", email="runner@example.com", password_hash="hash")
    project = Project(id="project-runner", user_id=user.id, name="Runner Project")
    provider = Provider(
        id="provider-runner",
        user_id=user.id,
        name="Runner Provider",
        kind="native",
        endpoint="https://runner-provider.example.com",
        api_key_enc="encrypted",
    )
    cached = CachedWorkflow(
        id="workflow-placeholder",
        user_id=user.id,
        provider_id=provider.id,
        external_id="placeholder",
        name="Placeholder",
        kind="agent",
    )
    wf = WorkflowDefinition(
        id="definition-runner",
        project_id=project.id,
        user_id=user.id,
        name="Inline Agent Workflow",
        execution_mode="graph",
        graph={"nodes": [], "edges": []},
        config={"provider": {"provider_id": provider.id}},
    )
    run = WorkflowRun(
        id="run-inline",
        project_id=project.id,
        user_id=user.id,
        provider_id=provider.id,
        workflow_id=cached.id,
        workflow_definition_id=wf.id,
        document_id="doc-runner",
        range_start=0,
        range_end=10,
        status="running",
        trace=[],
    )
    db.add_all([user, project, provider, cached, wf, run])
    db.commit()

    source_dir = tmp_path / "release-source"
    source_dir.mkdir(parents=True)
    (source_dir / "SKILL.md").write_text(
        "---\nname: reviewer\ndescription: Review things\n---\n# reviewer\n",
        encoding="utf-8",
    )
    release = SkillReleaseCacheService(db).publish_folder(
        namespace="official",
        slug="reviewer",
        version="1.0.0",
        display_name="Reviewer",
        visibility="public",
        source_dir=source_dir,
    )
    assert isinstance(release, SkillRelease)

    node = NodeContext(
        node_id="draft",
        node_type="agent",
        label="Draft",
        config={
            "agent_source": "inline",
            "instructions": "Write a concise draft.",
            "skills": [{"alias": "reviewer", "release_id": release.id}],
        },
        inputs={"prior_messages": [{"role": "user", "content": "Please draft."}]},
    )
    ctx = OrchestrationContext(
        workflow_def=wf,
        workflow_run=run,
        document_id="doc-runner",
        target_text="selected text",
        target_range={"from": 0, "to": 10},
        user_instruction="Please draft.",
        db=db,
        nodes={"draft": node},
        context_files=[],
        all_outputs=[],
        chat_log=[],
    )

    output = await WorkflowOrchestrator(db)._execute_agent_node(ctx, "draft")

    config = captured["config"]
    assert output["text"] == "release skill ok"
    assert config.workspace_root.endswith("/workflow-inline/definition-runner/draft")
    assert len(config.skills) == 1
    assert config.skills[0].id == "reviewer"
    assert config.skills[0].aliases == ["reviewer"]
    assert config.skills[0].folder_path == "skills/reviewer.skillref.json"
    ref_path = tmp_path / "native" / "runner" / "project-runner" / "workflow-inline" / "definition-runner" / "draft" / ".agents" / "skills" / "reviewer.skillref.json"
    assert ref_path.is_file()

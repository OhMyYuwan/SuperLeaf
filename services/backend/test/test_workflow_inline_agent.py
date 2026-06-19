from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import workflows
from app.database import Base
from app.models import (
    CachedWorkflow,
    NativeMcpServer,
    Project,
    Provider,
    Skill,
    SkillRelease,
    User,
    WorkflowDefinition,
    WorkflowRun,
    WorkflowTemplate,
)
from app.services import agent_orchestrator, agent_workspace_service, skill_release_cache_service
from app.services import workflow_template_service as workflow_templates
from app.services.agent_orchestrator import NodeContext, OrchestrationContext, WorkflowOrchestrator
from app.services.agent_workspace_service import AgentWorkspaceService
from app.services.skill_release_cache_service import SkillReleaseCacheService
from app.services.workflow_template_service import (
    SKILL_OPTIMIZATION_TEMPLATE_ID,
    WorkflowTemplateService,
    seed_builtin_templates,
)


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


def test_inline_agent_health_uses_node_provider_and_user_scope(db: Session) -> None:
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
                    "config": {
                        "agent_source": "inline",
                        "instructions": "Draft.",
                        "provider": {"provider_id": foreign_provider.id},
                    },
                },
                {"id": "output", "type": "output"},
            ],
            "edges": [],
        },
        config={"provider": {"provider_id": runner_provider.id}},
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

    wf.graph["nodes"][1]["config"]["provider"] = {"provider_id": runner_provider.id}
    db.commit()

    assert workflows._collect_unhealthy_agents(wf, db, project_id=project.id, user_id=runner.id) == []


def test_inline_agent_health_requires_node_provider_for_new_inline_nodes(db: Session) -> None:
    user = User(id="runner", email="runner@example.com", password_hash="hash")
    project = Project(id="project-runner", user_id=user.id, name="Runner Project")
    provider = Provider(
        id="provider-runner",
        user_id=user.id,
        name="Runner Provider",
        kind="native",
        endpoint="https://runner-provider.example.com",
    )
    wf = WorkflowDefinition(
        id="definition-runner",
        project_id=project.id,
        user_id=user.id,
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
        config={"provider": {"provider_id": provider.id}},
    )
    db.add_all([user, project, provider, wf])
    db.commit()

    assert workflows._collect_unhealthy_agents(wf, db, project_id=project.id, user_id=user.id) == [
        {
            "node_id": "draft",
            "agent_id": "",
            "provider_id": "",
            "reason": "provider_unconfigured",
        }
    ]

    wf.graph["nodes"][1]["config"]["provider_ref"] = "workflow_default"
    db.commit()

    assert workflows._collect_unhealthy_agents(wf, db, project_id=project.id, user_id=user.id) == []


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
    workflow_provider = Provider(
        id="provider-workflow",
        user_id=user.id,
        name="Workflow Provider",
        kind="native",
        endpoint="https://workflow-provider.example.com",
        api_key_enc="encrypted",
    )
    node_provider = Provider(
        id="provider-node",
        user_id=user.id,
        name="Node Provider",
        kind="native",
        endpoint="https://node-provider.example.com",
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
        provider_id=node_provider.id,
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
                "provider_id": workflow_provider.id,
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
        provider_id=node_provider.id,
        workflow_id=cached.id,
        workflow_definition_id=wf.id,
        document_id="doc-runner",
        range_start=0,
        range_end=10,
        status="running",
        trace=[],
    )
    db.add_all([user, project, workflow_provider, node_provider, mcp_server, cached, wf, run])
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
            "provider": {
                "provider_id": node_provider.id,
                "model": "node-model",
                "temperature": 0.2,
                "max_tokens": 222,
            },
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
    assert config.provider_endpoint == "https://node-provider.example.com"
    assert config.model == "node-model"
    assert config.temperature == 0.2
    assert config.max_tokens == 222
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
            "provider": {"provider_id": provider.id},
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
    ref_path = (
        tmp_path
        / "native"
        / "runner"
        / "project-runner"
        / "workflow-inline"
        / "definition-runner"
        / "draft"
        / ".agents"
        / "skills"
        / "reviewer.skillref.json"
    )
    assert ref_path.is_file()


def test_skill_optimization_template_prepare_migrates_required_skills_to_inline_refs(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_template_marketplace_installs(db, monkeypatch)
    user = User(id="runner", email="runner@example.com", password_hash="hash")
    project = Project(id="project-skill", user_id=user.id, name="Skill Project")
    db.add_all([user, project])
    seed_builtin_templates(db)

    result = WorkflowTemplateService(db).prepare(
        SKILL_OPTIMIZATION_TEMPLATE_ID,
        project_id=project.id,
        user_id=user.id,
    )

    assert result.error == ""
    assert result.installed_skills == [
        "skill-signal-analyst",
        "skill-rewriter",
        "skill-evaluator",
    ]

    rows = db.query(Skill).filter(Skill.owner_user_id == user.id).order_by(Skill.name.asc()).all()
    assert {row.name for row in rows} == {
        "skill-evaluator",
        "skill-rewriter",
        "skill-signal-analyst",
    }
    assert all(row.source == "marketplace" for row in rows)
    assert all(row.visibility == "private" for row in rows)
    assert all(row.content == "" for row in rows)

    release_ids_by_source_skill = {
        row.source_skill_id: row.id
        for row in db.query(SkillRelease).filter(SkillRelease.source_type == "marketplace").all()
    }
    skill_rows_by_name = {row.name: row for row in rows}
    nodes = {node["id"]: node for node in result.graph_template["nodes"]}
    for node_id, skill_name in [
        ("signal-analyst", "skill-signal-analyst"),
        ("skill-rewriter", "skill-rewriter"),
        ("skill-evaluator", "skill-evaluator"),
    ]:
        config = nodes[node_id]["config"]
        skill_row = skill_rows_by_name[skill_name]
        assert "skill_names" not in config
        assert config["agent_source"] == "inline"
        assert config["skills"] == [
            {
                "alias": skill_name,
                "source_skill_id": skill_row.id,
                "release_id": release_ids_by_source_skill[skill_row.id],
                "display_name": skill_name,
                "version": "1.0.0",
                "checksum": f"sha256:{skill_name}",
                "source": "marketplace",
                "marketplace_id": f"OhMyYuwan@{skill_name}",
                "install_command": _mock_marketplace_install_command(f"OhMyYuwan@{skill_name}"),
            }
        ]


def test_skill_optimization_template_uses_public_marketplace_skills(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_template_marketplace_installs(db, monkeypatch)
    user = User(id="runner", email="runner@example.com", password_hash="hash")
    project = Project(id="project-skill", user_id=user.id, name="Skill Project")
    db.add_all([user, project])
    seed_builtin_templates(db)

    template = db.get(WorkflowTemplate, SKILL_OPTIMIZATION_TEMPLATE_ID)
    assert template is not None
    required_by_name = {item["name"]: item for item in template.required_skills}
    assert required_by_name["skill-signal-analyst"]["marketplace_id"] == (
        "OhMyYuwan@skill-signal-analyst"
    )
    assert "content" not in required_by_name["skill-signal-analyst"]

    result = WorkflowTemplateService(db).prepare(
        SKILL_OPTIMIZATION_TEMPLATE_ID,
        project_id=project.id,
        user_id=user.id,
    )

    assert result.error == ""
    row = (
        db.query(Skill)
        .filter_by(
            owner_user_id=user.id,
            name="skill-signal-analyst",
            public_name="OhMyYuwan@skill-signal-analyst",
            source="marketplace",
        )
        .one()
    )
    release = db.query(SkillRelease).filter_by(source_skill_id=row.id).one()
    node = {item["id"]: item for item in result.graph_template["nodes"]}["signal-analyst"]
    ref = node["config"]["skills"][0]
    assert ref["release_id"] == release.id
    assert ref["marketplace_id"] == "OhMyYuwan@skill-signal-analyst"
    assert ref["install_command"] == _mock_marketplace_install_command(
        "OhMyYuwan@skill-signal-analyst"
    )


def test_template_prepare_migrates_single_string_skill_names_with_install_metadata(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_template_marketplace_installs(db, monkeypatch)
    user = User(id="runner", email="runner@example.com", password_hash="hash")
    project = Project(id="project-skill", user_id=user.id, name="Skill Project")
    template = WorkflowTemplate(
        id="single-string-skill-template",
        name="Single String Skill Template",
        description="legacy hand-authored skill_names string",
        graph_template={
            "nodes": [
                {
                    "id": "skill-evaluator",
                    "type": "agent",
                    "label": "Skill Evaluator",
                    "config": {
                        "inline_agent": True,
                        "skill_names": "skill-evaluator",
                        "provider": {},
                    },
                }
            ],
            "edges": [],
        },
        required_skills=[
            {
                "name": "skill-evaluator",
                "marketplace_id": "OhMyYuwan@skill-evaluator",
                "install_command": _mock_marketplace_install_command(
                    "OhMyYuwan@skill-evaluator"
                ),
            }
        ],
        category="test",
        is_builtin=False,
    )
    db.add_all([user, project, template])
    db.commit()

    result = WorkflowTemplateService(db).prepare(
        template.id,
        project_id=project.id,
        user_id=user.id,
    )

    assert result.error == ""
    node = result.graph_template["nodes"][0]
    assert "skill_names" not in node["config"]
    assert node["config"]["skills"][0] == {
        "alias": "skill-evaluator",
        "source_skill_id": db.query(Skill).filter_by(name="skill-evaluator").one().id,
        "release_id": db.query(SkillRelease).filter_by(slug="skill-evaluator").one().id,
        "display_name": "skill-evaluator",
        "version": "1.0.0",
        "checksum": "sha256:skill-evaluator",
        "source": "marketplace",
        "marketplace_id": "OhMyYuwan@skill-evaluator",
        "install_command": _mock_marketplace_install_command("OhMyYuwan@skill-evaluator"),
    }


def test_seed_builtin_templates_refreshes_existing_skill_optimization_template(
    db: Session,
) -> None:
    db.add(
        WorkflowTemplate(
            id=SKILL_OPTIMIZATION_TEMPLATE_ID,
            name="Old Skill Template",
            description="old",
            graph_template={"nodes": [], "edges": []},
            required_skills=[],
            category="legacy",
            is_builtin=False,
        )
    )
    db.commit()

    seed_builtin_templates(db)

    row = db.get(WorkflowTemplate, SKILL_OPTIMIZATION_TEMPLATE_ID)
    assert row is not None
    assert row.name == "Skill Optimization Pipeline"
    assert row.category == "optimization"
    assert row.is_builtin is True
    assert len(row.graph_template["nodes"]) == 5
    assert [item["name"] for item in row.required_skills] == [
        "skill-signal-analyst",
        "skill-rewriter",
        "skill-evaluator",
    ]
    assert [item["marketplace_id"] for item in row.required_skills] == [
        "OhMyYuwan@skill-signal-analyst",
        "OhMyYuwan@skill-rewriter",
        "OhMyYuwan@skill-evaluator",
    ]
    nodes = {node["id"]: node for node in row.graph_template["nodes"]}
    for node_id, skill_name in [
        ("signal-analyst", "skill-signal-analyst"),
        ("skill-rewriter", "skill-rewriter"),
        ("skill-evaluator", "skill-evaluator"),
    ]:
        config = nodes[node_id]["config"]
        assert "skill_names" not in config
        assert config["skills"] == [
            {
                "alias": skill_name,
                "display_name": skill_name,
                "source": "marketplace",
                "marketplace_id": f"OhMyYuwan@{skill_name}",
                "install_command": _mock_marketplace_install_command(
                    f"OhMyYuwan@{skill_name}"
                ),
            }
        ]


def test_skill_optimization_template_is_loaded_from_json_source(db: Session) -> None:
    source = (
        Path(__file__).resolve().parents[1]
        / "app"
        / "workflow_templates"
        / "skill_optimization.json"
    )
    payload = json.loads(source.read_text(encoding="utf-8"))

    seed_builtin_templates(db)

    row = db.get(WorkflowTemplate, SKILL_OPTIMIZATION_TEMPLATE_ID)
    assert row is not None
    assert row.name == payload["name"]
    assert row.description == payload["description"]
    assert row.category == payload["category"]
    assert row.graph_template == payload["graph_template"]
    assert row.required_skills == payload["required_skills"]


def _mock_template_marketplace_installs(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def install(self, skill_id: str, *, user_id: str):
        skill_name = skill_id.split("@", 1)[1]
        install_command = _mock_marketplace_install_command(skill_id)
        existing = (
            db.query(Skill)
            .filter_by(owner_user_id=user_id, public_name=skill_id, source="marketplace")
            .first()
        )
        if existing is None:
            existing = Skill(
                owner_user_id=user_id,
                name=skill_name,
                public_name=skill_id,
                description=f"{skill_name} from public marketplace",
                content="",
                visibility="private",
                source="marketplace",
                version=1,
                tags=["marketplace", f"marketplace:id={skill_id}"],
            )
            db.add(existing)
            db.flush()
        release = db.query(SkillRelease).filter_by(source_skill_id=existing.id).first()
        if release is None:
            release = SkillRelease(
                namespace="official-ohmyyuwan",
                slug=skill_name,
                display_name=skill_name,
                description=existing.description,
                version="1.0.0",
                visibility="public",
                storage_scope="server",
                artifact_checksum=f"sha256:{skill_name}",
                artifact_path=f"skill-content-cache/artifacts/fake/{skill_name}",
                source_type="marketplace",
                source_skill_id=existing.id,
                publisher_user_id="system",
                install_spec=(
                    f'{{"install_command":"{install_command}",'
                    f'"marketplace_id":"{skill_id}"}}'
                ),
                manifest={"name": skill_name},
            )
            db.add(release)
            db.flush()
        return existing, SimpleNamespace(id=skill_id, install_command=install_command)

    monkeypatch.setattr(workflow_templates.SkillMarketplaceService, "install", install)


def _mock_marketplace_install_command(skill_id: str) -> str:
    return (
        "npx --yes skills add "
        f"https://github.com/OhMyYuwan/SuperLeaf.Skills/tree/main/skills/{skill_id} "
        "--agent codex --copy --yes"
    )

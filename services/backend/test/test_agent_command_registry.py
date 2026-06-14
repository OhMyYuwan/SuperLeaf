"""Agent command context and registry behavior."""

from __future__ import annotations

import json

from app.agent_commands.context import AgentCommandContext, AgentCommandSource
from app.agent_commands.registry import (
    get_agent_command_prompts,
    get_agent_command_resources,
    get_agent_command_tools,
    read_agent_command_resource,
)


def test_agent_command_context_tracks_write_scope() -> None:
    ctx = AgentCommandContext(
        source=AgentCommandSource.MCP,
        user_id="user-a",
        token_id="token-a",
        token_scope="write",
        active_project_id="project-a",
    )

    assert ctx.can_write is True
    assert ctx.with_active_project("project-b").active_project_id == "project-b"
    assert ctx.active_project_id == "project-a"


def test_agent_command_registry_loads_shared_manifest() -> None:
    tools = get_agent_command_tools()
    names = {tool["name"] for tool in tools}

    assert "superleaf_list_projects" in names
    assert "project_read_doc" in names
    assert "propose_doc_edit" in names
    assert all({"name", "description", "inputSchema"}.issubset(set(tool)) for tool in tools)


def test_agent_command_registry_preserves_tool_semantics_metadata() -> None:
    tools = {tool["name"]: tool for tool in get_agent_command_tools()}

    read_doc = tools["project_read_doc"]
    assert read_doc["annotations"]["readOnlyHint"] is True
    assert read_doc["_meta"]["superleaf"]["writeSurface"] == "none"
    assert read_doc["_meta"]["superleaf"]["groundTruth"] == "db_snapshot"

    proposal = tools["propose_doc_edit"]
    assert proposal["annotations"]["readOnlyHint"] is False
    assert proposal["annotations"]["destructiveHint"] is False
    assert proposal["_meta"]["superleaf"]["writeSurface"] == "proposal_db"
    assert proposal["_meta"]["superleaf"]["bodyMutation"] == "on_user_accept_via_yjs"
    assert proposal["_meta"]["superleaf"]["anchorPolicy"] == "resolve_by_original_text"

    create_file = tools["project_write_text_file"]
    assert create_file["_meta"]["superleaf"]["writeSurface"] == "file_tree_db"

    resource = read_agent_command_resource("superleaf://tool-kernel/tools")
    assert resource is not None
    body = json.loads(resource["contents"][0]["text"])
    catalog_tools = {tool["name"]: tool for tool in body["tools"]}
    assert catalog_tools["create_suggestion"]["_meta"]["superleaf"]["writeSurface"] == "annotation_db"


def test_agent_command_registry_exposes_resources_and_prompts() -> None:
    resources = get_agent_command_resources()
    prompts = get_agent_command_prompts()

    assert any(item["uri"] == "superleaf://tool-kernel/tools" for item in resources)
    assert any(item["name"] == "superleaf_project_review" for item in prompts)

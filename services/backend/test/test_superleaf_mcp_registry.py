import json

from app.services.superleaf_mcp_registry import (
    get_mcp_prompts,
    get_mcp_resources,
    get_mcp_tools,
    get_registry_manifest,
    read_mcp_resource,
    render_mcp_prompt,
)


def test_registry_loads_shared_tools():
    tools = get_mcp_tools()
    names = {tool["name"] for tool in tools}

    assert "superleaf_list_projects" in names
    assert "project_read_doc" in names
    assert "project_grep" in names
    assert all({"name", "description", "inputSchema"}.issubset(set(tool)) for tool in tools)
    by_name = {tool["name"]: tool for tool in tools}
    assert by_name["propose_doc_edit"]["_meta"]["superleaf"]["writeSurface"] == "proposal_db"
    assert by_name["project_read_doc"]["annotations"]["readOnlyHint"] is True


def test_registry_loads_resources_and_prompts():
    resources = get_mcp_resources()
    prompts = get_mcp_prompts()

    assert any(item["uri"] == "superleaf://tool-kernel/tools" for item in resources)
    assert any(item["name"] == "superleaf_project_review" for item in prompts)


def test_tools_manifest_resource_contains_sanitized_registry():
    resource = read_mcp_resource("superleaf://tool-kernel/tools")

    assert resource is not None
    assert resource["contents"][0]["mimeType"] == "application/json"
    body = json.loads(resource["contents"][0]["text"])
    by_name = {tool["name"]: tool for tool in body["tools"]}
    assert "superleaf_list_projects" in by_name
    assert by_name["create_suggestion"]["_meta"]["superleaf"]["anchorPolicy"] == "resolve_by_original_text"


def test_prompt_template_renders_arguments():
    prompt = render_mcp_prompt("superleaf_project_review", {"task": "检查摘要"})

    assert prompt is not None
    assert prompt["messages"][0]["role"] == "user"
    assert "检查摘要" in prompt["messages"][0]["content"]["text"]


def test_registry_manifest_has_version_and_id():
    manifest = get_registry_manifest()

    assert manifest["id"] == "superleaf.tools"
    assert manifest["version"] == 1

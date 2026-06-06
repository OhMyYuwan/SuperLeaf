import io
import json
import zipfile

from app.api import native_agents


def test_local_agent_host_fallback_package_contains_cross_platform_assets():
    repo_root = native_agents._repo_root()
    expected_version = native_agents._local_agent_host_version(repo_root / "services" / "local-agent-host")
    filename, payload = native_agents._build_local_agent_host_package(repo_root)
    entries = set(native_agents._local_agent_host_package_entries(payload))

    assert filename == f"superleaf-local-agent-host-{expected_version}.zip"
    assert {
        "server.mjs",
        "superleaf-tools.mjs",
        "superleaf-tools.json",
        "start-local-agent-host.command",
        "start-local-agent-host-background.command",
        "stop-local-agent-host.command",
        "start-local-agent-host.cmd",
        "start-local-agent-host-background.cmd",
        "stop-local-agent-host.cmd",
        "start-local-agent-host.ps1",
        "start-local-agent-host-background.ps1",
        "stop-local-agent-host.ps1",
        "install-local-agent-host-startup.command",
        "uninstall-local-agent-host-startup.command",
        "install-local-agent-host-startup.cmd",
        "uninstall-local-agent-host-startup.cmd",
        "install-local-agent-host-startup.ps1",
        "uninstall-local-agent-host-startup.ps1",
        "scripts/smoke-mcp.mjs",
        "scripts/mcp-sdk-migration-gate.mjs",
        "scripts/mcp-inspector.mjs",
        "scripts/local-agent-compat-matrix.mjs",
        "scripts/nanobot-tool-calls-matrix.mjs",
        "superleaf-local-agent-host.manifest.json",
    }.issubset(entries)

    with zipfile.ZipFile(io.BytesIO(payload), mode="r") as zf:
        assert any(name.endswith("/superleaf-tools.json") for name in zf.namelist())
        manifest_name = next(name for name in zf.namelist() if name.endswith("/superleaf-local-agent-host.manifest.json"))
        manifest = json.loads(zf.read(manifest_name).decode("utf-8"))
    assert manifest["kind"] == "superleaf.local_agent_host.package"
    assert manifest["version"] == expected_version
    assert manifest["platforms"]["macos"]["install_start_at_login"] == "install-local-agent-host-startup.command"
    assert manifest["platforms"]["windows"]["install_start_at_login"] == "install-local-agent-host-startup.cmd"
    assert manifest["verification"]["checksum_algorithm"] == "sha256"


def test_local_agent_host_package_info_exposes_install_metadata(monkeypatch):
    repo_root = native_agents._repo_root()
    expected_version = native_agents._local_agent_host_version(repo_root / "services" / "local-agent-host")
    filename, payload = native_agents._build_local_agent_host_package(repo_root)
    monkeypatch.setattr(native_agents, "_local_agent_host_package", lambda: (filename, payload))

    info = native_agents._local_agent_host_package_info()

    assert info.version == expected_version
    assert info.filename == filename
    assert info.checksum_algorithm == "sha256"
    assert len(info.sha256) == 64
    assert info.endpoint == "http://127.0.0.1:8787"
    assert info.mcp_url == "http://127.0.0.1:8787/mcp"
    assert info.manifest_filename == "superleaf-local-agent-host.manifest.json"
    assert info.manifest["kind"] == "superleaf.local_agent_host.package"
    assert info.macos["background"] == "start-local-agent-host-background.command"
    assert info.macos["install_start_at_login"] == "install-local-agent-host-startup.command"
    assert info.windows["background"] == "start-local-agent-host-background.cmd"
    assert info.windows["install_start_at_login"] == "install-local-agent-host-startup.cmd"
    assert info.codex_env["SL_LOCAL_AGENT_HOST_CODEX_AUTO_MCP"] == "1"
    assert info.claude_env["SL_LOCAL_AGENT_HOST_CLAUDE_PERMISSION_MODE"] == "default"


def test_local_agent_host_update_metadata_uses_current_package(monkeypatch):
    repo_root = native_agents._repo_root()
    filename, payload = native_agents._build_local_agent_host_package(repo_root)
    monkeypatch.setattr(native_agents, "_local_agent_host_package", lambda: (filename, payload))

    update = native_agents.get_local_agent_host_update(current_version="0.0.0", user=None)

    assert update.latest_version == update.package.version
    assert update.sha256 == update.package.sha256
    assert update.package.filename == filename
    assert update.update_available is True


def test_local_agent_host_package_ignores_stale_dist_archive(monkeypatch, tmp_path):
    root = tmp_path
    dist = root / "dist"
    dist.mkdir()
    stale_path = dist / "superleaf-local-agent-host-0.1.0.zip"
    with zipfile.ZipFile(stale_path, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("superleaf-local-agent-host-0.1.0/server.mjs", "console.log('stale')\n")

    fallback_payload = b"fallback"
    monkeypatch.setattr(native_agents, "_repo_root", lambda: root)
    monkeypatch.setattr(
        native_agents,
        "_build_local_agent_host_package",
        lambda package_root: ("superleaf-local-agent-host-0.1.0.zip", fallback_payload),
    )

    filename, payload = native_agents._local_agent_host_package()

    assert filename == "superleaf-local-agent-host-0.1.0.zip"
    assert payload == fallback_payload

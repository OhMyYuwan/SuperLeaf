"""Native Agent registry APIs.

Phase 1 exposes configuration surfaces only. SDK execution is intentionally
left for a follow-up request.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
import re
import zipfile
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, object_session

from ..database import get_session
from ..models import (
    NativeAgent,
    NativeAgentCredential,
    NativeAgentSkillInstall,
    NativeMcpServer,
    Project,
    Skill,
    User,
)
from ..schemas import (
    AgentWorkspaceFileOut,
    McpExecutionPolicyOut,
    McpGoldenTestIn,
    McpProbeIn,
    NativeAgentCredentialIn,
    NativeAgentCredentialOut,
    NativeAgentCredentialPatch,
    NativeAgentIn,
    NativeAgentOut,
    NativeAgentPatch,
    NativeAgentSkillInstallOut,
    NativeAgentSkillRecipeIn,
    NativeMcpServerIn,
    NativeMcpServerOut,
    NativeMcpServerPatch,
    SkillIn,
    SkillMarketplaceEntryOut,
    SkillMarketplaceCloneIn,
    SkillMarketplaceCloneOut,
    SkillMarketplaceInstallOut,
    SkillMarketplaceOut,
    SkillOut,
    SkillUsageOut,
    SkillPatch,
    SkillRecipeIn,
)
from ..services.agent_workspace_service import AgentWorkspaceError, AgentWorkspaceService
from ..services.mcp_catalog_service import McpCatalogError, McpCatalogService
from ..services.mcp_config_service import McpConfigService, env_keys
from ..services.mcp_policy import McpExecutionPolicyError, ensure_mcp_transport_allowed
from ..services.native_agent_service import NativeAgentService
from ..services.skill_content_crypto import decrypt_skill_content
from ..services.skill_marketplace_service import (
    MarketplaceEntry,
    SkillMarketplaceError,
    SkillMarketplaceService,
)
from ..settings import settings
from .deps import get_current_project, get_current_user, require_write_access

router = APIRouter(prefix="/api/native-agent", tags=["native-agent"])

OFFICIAL_BADGE_STYLES = {"metal", "minimal"}
_official_badge_style_override: str | None = None
LOCAL_AGENT_HOST_PACKAGE_GLOB = "superleaf-local-agent-host-*.zip"
LOCAL_AGENT_HOST_BUNDLE_FILES = [
    "package.json",
    "server.mjs",
    "README.md",
    ".env.example",
    "start-local-agent-host.sh",
    "start-local-agent-host.command",
    "start-local-agent-host-background.command",
    "stop-local-agent-host.command",
    "scripts/package.mjs",
]


class OfficialBadgeUiPatch(BaseModel):
    style: str = Field(pattern="^(metal|minimal)$")


def _credential_out(row: NativeAgentCredential) -> NativeAgentCredentialOut:
    return NativeAgentCredentialOut(
        id=row.id,
        user_id=row.user_id,
        name=row.name,
        base_url=row.base_url,
        runtime_kind=row.runtime_kind,
        default_model=row.default_model,
        status=row.status,
        status_detail=row.status_detail,
        meta=row.meta or {},
        created_at=row.created_at,
        updated_at=row.updated_at,
        has_api_key=bool(row.api_key_enc),
    )


def _skill_out(row: Skill, user_id: str) -> SkillOut:
    out = SkillOut.model_validate(row, from_attributes=True)
    session = object_session(row)
    if session:
        svc = NativeAgentService(session)
        out.can_edit = svc.can_edit_skill(row, user_id=user_id)
        out.used_by_agent_count = len(svc.agents_using_skill(row.id, user_id=user_id))
    out.content = decrypt_skill_content(row.content)
    return out


def _skill_export_folder_name(row: Skill) -> str:
    raw_name = (row.name or "skill").strip()
    safe_name = re.sub(r"[\x00-\x1f/\\:]+", "-", raw_name).strip(" .")
    return safe_name[:100] or "skill"


def _skill_export_archive(row: Skill) -> tuple[str, bytes]:
    if row.source == "project":
        return _project_skill_export_archive(row)
    folder_name = _skill_export_folder_name(row)
    content = decrypt_skill_content(row.content)
    manifest = {
        "schema_version": 1,
        "kind": "superleaf.skill.export",
        "name": row.name,
        "public_name": row.public_name,
        "description": row.description,
        "entry": "SKILL.md",
        "source": row.source,
        "visibility": row.visibility,
        "version": row.version,
        "tags": list(row.tags or []),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{folder_name}/SKILL.md", content)
        zf.writestr(
            f"{folder_name}/manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        )
    return folder_name, archive.getvalue()


def _project_skill_export_archive(row: Skill) -> tuple[str, bytes]:
    folder_name = _skill_export_folder_name(row)
    if not row.cache_path:
        raise ValueError("Project Skill cache is missing; update Skill cache first")
    root = Path(row.cache_path)
    if not root.exists() or not root.is_dir() or not (root / "SKILL.md").is_file():
        raise ValueError("Project Skill cache is missing; update Skill cache first")
    manifest = {
        "schema_version": 1,
        "kind": "superleaf.skill.export",
        "name": row.name,
        "public_name": row.public_name,
        "description": row.description,
        "entry": "SKILL.md",
        "source": row.source,
        "project_id": row.project_id,
        "cache_version": row.cache_version,
        "cache_updated_at": row.cache_updated_at.isoformat() if row.cache_updated_at else None,
        "visibility": row.visibility,
        "version": row.version,
        "tags": list(row.tags or []),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(root)
            if ".git" in rel.parts or any(part in {"", ".", ".."} for part in rel.parts):
                continue
            zf.write(path, f"{folder_name}/{rel.as_posix()}")
        zf.writestr(
            f"{folder_name}/manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        )
    return folder_name, archive.getvalue()


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _local_agent_host_package() -> tuple[str, bytes]:
    root = _repo_root()
    packaged = sorted(
        (root / "dist").glob(LOCAL_AGENT_HOST_PACKAGE_GLOB),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    if packaged:
        package_path = packaged[0]
        return package_path.name, package_path.read_bytes()

    host_root = root / "services" / "local-agent-host"
    if not host_root.exists() or not host_root.is_dir():
        raise FileNotFoundError("Local Agent Host source directory is missing")
    package_json = host_root / "package.json"
    version = "0.1.0"
    if package_json.exists():
        try:
            version = json.loads(package_json.read_text(encoding="utf-8")).get("version") or version
        except (OSError, json.JSONDecodeError):
            version = "0.1.0"
    bundle_name = f"superleaf-local-agent-host-{version}"
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for relative in LOCAL_AGENT_HOST_BUNDLE_FILES:
            source = host_root / relative
            if not source.is_file():
                continue
            zf.write(source, f"{bundle_name}/{relative}")
    return f"{bundle_name}.zip", archive.getvalue()


def _agent_out(row: NativeAgent) -> NativeAgentOut:
    return NativeAgentOut.model_validate(row, from_attributes=True)


def _install_out(row: NativeAgentSkillInstall) -> NativeAgentSkillInstallOut:
    return NativeAgentSkillInstallOut.model_validate(row, from_attributes=True)


def _mcp_server_out(row: NativeMcpServer) -> NativeMcpServerOut:
    return NativeMcpServerOut(
        id=row.id,
        user_id=row.user_id,
        preset_id=row.preset_id,
        source=row.source,
        name=row.name,
        description=row.description,
        transport=row.transport,
        endpoint=row.command if row.transport == "remote" else "",
        command=row.command,
        args=list(row.args or []),
        env_keys=env_keys(row.env_enc),
        allowed_tools=list(row.allowed_tools or []),
        is_enabled=row.is_enabled,
        status=row.status,
        status_detail=row.status_detail,
        last_probe_at=row.last_probe_at,
        last_probe_status=row.last_probe_status,
        last_probe_detail=row.last_probe_detail,
        last_golden_at=row.last_golden_at,
        last_golden_status=row.last_golden_status,
        last_golden_detail=row.last_golden_detail,
        last_tool_count=row.last_tool_count,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _marketplace_entry_out(entry: MarketplaceEntry) -> SkillMarketplaceEntryOut:
    return SkillMarketplaceEntryOut(**entry.__dict__)


def _normalized_official_badge_style(value: str | None) -> str:
    cleaned = (value or "").strip().lower()
    return cleaned if cleaned in OFFICIAL_BADGE_STYLES else "metal"


def _official_badge_toggle_enabled() -> bool:
    raw = os.environ.get("YLW_OFFICIAL_BADGE_STYLE_TOGGLE_ENABLED", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _official_badge_ui_payload() -> dict:
    configured = _normalized_official_badge_style(os.environ.get("YLW_OFFICIAL_BADGE_STYLE"))
    style = _official_badge_style_override or configured
    return {
        "style": style,
        "allowed_styles": ["metal", "minimal"],
        "toggle_enabled": _official_badge_toggle_enabled(),
        "source": "runtime_override" if _official_badge_style_override else "env",
    }


@router.get("/ui/official-badge")
def get_official_badge_ui(
    user: User = Depends(get_current_user),
) -> dict:
    return _official_badge_ui_payload()


@router.patch("/ui/official-badge")
def update_official_badge_ui(
    body: OfficialBadgeUiPatch,
    user: User = Depends(get_current_user),
) -> dict:
    if not _official_badge_toggle_enabled():
        raise HTTPException(403, "Official badge style toggle is disabled by backend configuration")
    global _official_badge_style_override
    _official_badge_style_override = _normalized_official_badge_style(body.style)
    return _official_badge_ui_payload()


@router.get("/mcp/catalog")
def get_mcp_catalog(
    user: User = Depends(get_current_user),
) -> dict:
    try:
        return McpCatalogService().catalog()
    except McpCatalogError as exc:
        raise HTTPException(500, str(exc)) from exc


@router.get("/mcp/policy", response_model=McpExecutionPolicyOut)
def get_mcp_execution_policy(
    user: User = Depends(get_current_user),
) -> McpExecutionPolicyOut:
    allowed_transports: list[str] = []
    if settings.mcp_remote_enabled:
        allowed_transports.append("remote")
    if settings.mcp_stdio_enabled:
        allowed_transports.append("stdio")
    return McpExecutionPolicyOut(
        remote_enabled=settings.mcp_remote_enabled,
        stdio_enabled=settings.mcp_stdio_enabled,
        inline_config_enabled=settings.mcp_inline_config_enabled,
        remote_private_networks_enabled=settings.mcp_remote_private_networks_enabled,
        allowed_transports=allowed_transports,
    )


@router.post("/mcp/probe")
async def probe_mcp_server(
    body: McpProbeIn,
    user: User = Depends(get_current_user),
) -> dict:
    svc = McpCatalogService()
    try:
        preset = svc.preset(body.preset_id) if body.preset_id else None
        if body.server is not None:
            server = body.server.model_dump()
        elif preset is not None:
            server = svc.server_config_from_preset(
                preset,
                env=body.env,
                allowed_tools=body.allowed_tools,
            )
        else:
            raise HTTPException(400, "preset_id or server is required")
        ensure_mcp_transport_allowed(str(server.get("transport") or "stdio"))
        return await svc.probe(server, preset=preset)
    except McpExecutionPolicyError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except McpCatalogError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/mcp/golden-test")
async def run_mcp_golden_test(
    body: McpGoldenTestIn,
    user: User = Depends(get_current_user),
) -> dict:
    svc = McpCatalogService()
    try:
        server = body.server.model_dump() if body.server is not None else None
        if server is not None:
            ensure_mcp_transport_allowed(str(server.get("transport") or "stdio"))
        return await svc.golden_test(
            preset_id=body.preset_id,
            test_id=body.test_id,
            server=server,
            env=body.env,
        )
    except McpExecutionPolicyError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except McpCatalogError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/mcp/servers", response_model=list[NativeMcpServerOut])
def list_mcp_servers(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[NativeMcpServerOut]:
    return [_mcp_server_out(row) for row in McpConfigService(db).list_servers(user_id=user.id)]


@router.post("/mcp/servers", response_model=NativeMcpServerOut, status_code=201)
def create_mcp_server(
    body: NativeMcpServerIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeMcpServerOut:
    svc = McpConfigService(db)
    try:
        if body.source == "catalog" or body.preset_id:
            row = svc.ensure_preset_server(body.preset_id, user_id=user.id, env=body.env)
            patch: dict = {}
            for key in ("name", "description", "allowed_tools", "is_enabled"):
                value = getattr(body, key)
                if value not in ("", [], None):
                    patch[key] = value
            if patch:
                row = svc.update_server(row.id, user_id=user.id, patch=patch) or row
        else:
            row = svc.create_custom_server(
                user_id=user.id,
                name=body.name,
                description=body.description,
                transport=body.transport,
                endpoint=body.endpoint,
                command=body.command,
                args=body.args,
                env=body.env,
                allowed_tools=body.allowed_tools,
                is_enabled=body.is_enabled,
            )
        return _mcp_server_out(row)
    except (McpCatalogError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/mcp/servers/from-preset/{preset_id}", response_model=NativeMcpServerOut, status_code=201)
def ensure_mcp_preset_server(
    preset_id: str,
    body: NativeMcpServerIn | None = None,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeMcpServerOut:
    try:
        env = body.env if body is not None else None
        return _mcp_server_out(McpConfigService(db).ensure_preset_server(preset_id, user_id=user.id, env=env))
    except McpCatalogError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.patch("/mcp/servers/{server_id}", response_model=NativeMcpServerOut)
def update_mcp_server(
    server_id: str,
    body: NativeMcpServerPatch,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeMcpServerOut:
    try:
        row = McpConfigService(db).update_server(
            server_id,
            user_id=user.id,
            patch=body.model_dump(exclude_unset=True),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if row is None:
        raise HTTPException(404, "MCP server not found")
    return _mcp_server_out(row)


@router.delete("/mcp/servers/{server_id}", status_code=204)
def delete_mcp_server(
    server_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    McpConfigService(db).delete_server(server_id, user_id=user.id)


@router.post("/mcp/servers/{server_id}/probe")
async def probe_saved_mcp_server(
    server_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    config_svc = McpConfigService(db)
    row = config_svc.get_server(server_id, user_id=user.id)
    if row is None:
        raise HTTPException(404, "MCP server not found")
    catalog_svc = McpCatalogService()
    try:
        preset = catalog_svc.preset(row.preset_id) if row.preset_id else None
        runtime_server = config_svc.to_runtime_server(row)
        ensure_mcp_transport_allowed(str(runtime_server.get("transport") or "stdio"))
        result = await catalog_svc.probe(runtime_server, preset=preset)
        tool_count = len(result.get("tools") or [])
        detail = f"{tool_count} tools"
        warnings = result.get("warnings") or []
        if warnings:
            detail = f"{detail}; {'; '.join(str(item) for item in warnings)}"
        config_svc.mark_probe(
            server_id,
            user_id=user.id,
            status=str(result.get("status") or "unknown"),
            detail=detail,
            tool_count=tool_count,
        )
        return result
    except McpExecutionPolicyError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except McpCatalogError as exc:
        config_svc.mark_probe(server_id, user_id=user.id, status="error", detail=str(exc), tool_count=0)
        raise HTTPException(400, str(exc)) from exc


@router.post("/mcp/servers/{server_id}/golden-test")
async def run_saved_mcp_golden_test(
    server_id: str,
    body: dict | None = None,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    config_svc = McpConfigService(db)
    row = config_svc.get_server(server_id, user_id=user.id)
    if row is None:
        raise HTTPException(404, "MCP server not found")
    if not row.preset_id:
        raise HTTPException(400, "golden test requires a catalog preset")
    try:
        runtime_server = config_svc.to_runtime_server(row)
        ensure_mcp_transport_allowed(str(runtime_server.get("transport") or "stdio"))
        result = await McpCatalogService().golden_test(
            preset_id=row.preset_id,
            test_id=str((body or {}).get("test_id") or ""),
            server=runtime_server,
        )
        warnings = result.get("warnings") or []
        error = str(result.get("error") or "").strip()
        test_id = str(result.get("test_id") or "").strip()
        detail_parts = [test_id] if test_id else []
        if error:
            detail_parts.append(error)
        if warnings:
            detail_parts.append("; ".join(str(item) for item in warnings))
        config_svc.mark_golden(
            server_id,
            user_id=user.id,
            status="ok" if result.get("passed") else "error",
            detail=" · ".join(detail_parts) or ("passed" if result.get("passed") else "failed"),
        )
        return result
    except McpExecutionPolicyError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except McpCatalogError as exc:
        config_svc.mark_golden(server_id, user_id=user.id, status="error", detail=str(exc))
        raise HTTPException(400, str(exc)) from exc


@router.get("/credentials", response_model=list[NativeAgentCredentialOut])
def list_credentials(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[NativeAgentCredentialOut]:
    return [_credential_out(r) for r in NativeAgentService(db).list_credentials(user_id=user.id)]


@router.post("/credentials", response_model=NativeAgentCredentialOut, status_code=201)
def create_credential(
    body: NativeAgentCredentialIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentCredentialOut:
    row = NativeAgentService(db).create_credential(
        user_id=user.id,
        name=body.name,
        base_url=body.base_url,
        api_key=body.api_key,
        runtime_kind=body.runtime_kind,
        default_model=body.default_model,
    )
    return _credential_out(row)


@router.patch("/credentials/{credential_id}", response_model=NativeAgentCredentialOut)
def update_credential(
    credential_id: str,
    body: NativeAgentCredentialPatch,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentCredentialOut:
    row = NativeAgentService(db).update_credential(
        credential_id,
        user_id=user.id,
        name=body.name,
        base_url=body.base_url,
        api_key=body.api_key,
        runtime_kind=body.runtime_kind,
        default_model=body.default_model,
    )
    if row is None:
        raise HTTPException(404, "credential not found")
    return _credential_out(row)


@router.delete("/credentials/{credential_id}", status_code=204)
def delete_credential(
    credential_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    NativeAgentService(db).delete_credential(credential_id, user_id=user.id)


@router.post("/credentials/{credential_id}/probe", response_model=NativeAgentCredentialOut)
def probe_credential(
    credential_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentCredentialOut:
    row = NativeAgentService(db).mark_credential_probe(credential_id, user_id=user.id)
    if row is None:
        raise HTTPException(404, "credential not found")
    return _credential_out(row)


@router.get("/skills", response_model=list[SkillOut])
def list_skills(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[SkillOut]:
    return [_skill_out(r, user.id) for r in NativeAgentService(db).list_skills(user_id=user.id)]


@router.post("/skills", response_model=SkillOut, status_code=201)
def create_skill(
    body: SkillIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillOut:
    try:
        row = NativeAgentService(db).create_skill(
            user_id=user.id,
            name=body.name,
            folder_name=body.folder_name,
            entry_filename=body.entry_filename,
            description=body.description,
            content=body.content,
            tags=body.tags,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _skill_out(row, user.id)


@router.post("/skills/recipe", response_model=SkillOut, status_code=201)
def create_recipe_skill(
    body: SkillRecipeIn,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillOut:
    try:
        row = NativeAgentService(db).create_recipe_skill(
            user_id=user.id,
            name=body.name,
            description=body.description,
            repo_url=body.repo_url,
            source_url=body.source_url,
            source_ref=body.source_ref,
            skill_name=body.skill_name,
            install_command=body.install_command,
            tags=body.tags,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _skill_out(row, user.id)


@router.patch("/skills/{skill_id}", response_model=SkillOut)
def update_skill(
    skill_id: str,
    body: SkillPatch,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillOut:
    try:
        row = NativeAgentService(db).update_skill(
            skill_id,
            user_id=user.id,
            name=body.name,
            description=body.description,
            content=body.content,
            tags=body.tags,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if row is None:
        raise HTTPException(404, "skill not found")
    return _skill_out(row, user.id)


@router.post("/skills/{skill_id}/publish", response_model=SkillOut)
def publish_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillOut:
    try:
        row = NativeAgentService(db).publish_skill(skill_id, user_id=user.id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if row is None:
        raise HTTPException(404, "skill not found")
    return _skill_out(row, user.id)


@router.post("/skills/{skill_id}/unpublish", response_model=SkillOut)
def unpublish_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillOut:
    row = NativeAgentService(db).unpublish_skill(skill_id, user_id=user.id)
    if row is None:
        raise HTTPException(404, "skill not found")
    return _skill_out(row, user.id)


@router.delete("/skills/{skill_id}", status_code=204)
def delete_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    NativeAgentService(db).delete_skill(skill_id, user_id=user.id)


@router.get("/local-agent-host/download")
def download_local_agent_host(
    user: User = Depends(get_current_user),
) -> Response:
    del user
    try:
        filename, payload = _local_agent_host_package()
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    disposition = f"attachment; filename=\"superleaf-local-agent-host.zip\"; filename*=UTF-8''{quote(filename)}"
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": disposition},
    )


@router.get("/skills/{skill_id}/download")
def download_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> Response:
    row = NativeAgentService(db).get_skill(skill_id, user_id=user.id)
    if row is None:
        raise HTTPException(404, "skill not found")
    try:
        folder_name, payload = _skill_export_archive(row)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    filename = f"{folder_name}.zip"
    disposition = f"attachment; filename=\"skill.zip\"; filename*=UTF-8''{quote(filename)}"
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": disposition},
    )


@router.get("/skills/{skill_id}/usage", response_model=list[SkillUsageOut])
def list_skill_usage(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[SkillUsageOut]:
    """List Agents that currently bind this skill — used by the frontend's
    delete-confirmation dialog so the user knows whose Agents will lose the
    skill before clicking through."""
    agents = NativeAgentService(db).agents_using_skill(skill_id, user_id=user.id)
    return [
        SkillUsageOut(agent_id=a.id, agent_name=a.name, project_id=a.project_id)
        for a in agents
    ]


@router.get("/skill-marketplace", response_model=SkillMarketplaceOut)
def list_skill_marketplace(
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillMarketplaceOut:
    svc = SkillMarketplaceService(db)
    try:
        entries = svc.list_entries(user_id=user.id)
    except SkillMarketplaceError as exc:
        raise HTTPException(502, str(exc)) from exc
    return SkillMarketplaceOut(
        catalog_url=svc.catalog_url,
        skills=[_marketplace_entry_out(entry) for entry in entries],
    )


@router.post("/skill-marketplace/{skill_id}/install", response_model=SkillMarketplaceInstallOut)
def install_marketplace_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillMarketplaceInstallOut:
    svc = SkillMarketplaceService(db)
    try:
        row, entry = svc.install(skill_id, user_id=user.id)
    except SkillMarketplaceError as exc:
        raise HTTPException(400, str(exc)) from exc
    return SkillMarketplaceInstallOut(
        skill=_skill_out(row, user.id),
        marketplace_entry=_marketplace_entry_out(entry),
    )


@router.post("/skill-marketplace/{skill_id}/update", response_model=SkillMarketplaceInstallOut)
def update_marketplace_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillMarketplaceInstallOut:
    return install_marketplace_skill(skill_id, db=db, user=user)


@router.delete("/skill-marketplace/{skill_id}/uninstall", status_code=204)
def uninstall_marketplace_skill(
    skill_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    SkillMarketplaceService(db).uninstall(skill_id, user_id=user.id)


@router.post("/skill-marketplace/{skill_id}/clone-to-local", response_model=SkillMarketplaceCloneOut, status_code=201)
def clone_marketplace_skill_to_local(
    skill_id: str,
    body: SkillMarketplaceCloneIn = SkillMarketplaceCloneIn(),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> SkillMarketplaceCloneOut:
    """Fetch the marketplace SKILL.md, create an editable local copy, and remove the marketplace installation."""
    try:
        row = SkillMarketplaceService(db).clone_to_local(skill_id, user_id=user.id, name=body.name)
    except SkillMarketplaceError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return SkillMarketplaceCloneOut(skill=_skill_out(row, user.id))


@router.get("/agents", response_model=list[NativeAgentOut])
def list_agents(
    provider_id: str | None = None,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[NativeAgentOut]:
    svc = NativeAgentService(db)
    rows = (
        svc.list_agents_for_provider(project_id=project.id, user_id=user.id, provider_id=provider_id)
        if provider_id
        else svc.list_agents(project_id=project.id, user_id=user.id)
    )
    return [_agent_out(r) for r in rows]


@router.post("/agents", response_model=NativeAgentOut, status_code=201)
def create_agent(
    body: NativeAgentIn,
    project: Project = Depends(require_write_access),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentOut:
    try:
        row = NativeAgentService(db).create_agent(
            project_id=project.id,
            user_id=user.id,
            name=body.name,
            description=body.description,
            provider_id=body.provider_id,
            model=body.model,
            instructions=body.instructions,
            agent_md=body.agent_md,
            skill_ids=body.skill_ids,
            skill_recipes=body.skill_recipes,
            output_contract=body.output_contract,
            runtime_config=body.runtime_config,
            is_enabled=body.is_enabled,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _agent_out(row)


@router.get("/agents/{agent_id}/skills", response_model=list[NativeAgentSkillInstallOut])
def list_agent_skill_installs(
    agent_id: str,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[NativeAgentSkillInstallOut]:
    rows = NativeAgentService(db).list_agent_skill_installs(agent_id, project_id=project.id, user_id=user.id)
    return [_install_out(row) for row in rows]


@router.post(
    "/agents/{agent_id}/skills/install-npx",
    response_model=NativeAgentSkillInstallOut,
    status_code=201,
)
def install_agent_skill_recipe(
    agent_id: str,
    body: NativeAgentSkillRecipeIn,
    project: Project = Depends(require_write_access),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentSkillInstallOut:
    try:
        row = NativeAgentService(db).install_agent_skill_recipe(
            agent_id,
            project_id=project.id,
            user_id=user.id,
            recipe=body,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if row is None:
        raise HTTPException(404, "native agent not found")
    return _install_out(row)


@router.get("/agents/{agent_id}/workspace/tree", response_model=list[AgentWorkspaceFileOut])
def agent_workspace_tree(
    agent_id: str,
    project: Project = Depends(get_current_project),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[AgentWorkspaceFileOut]:
    agent = NativeAgentService(db).get_agent(agent_id, project_id=project.id, user_id=user.id)
    if agent is None:
        raise HTTPException(404, "native agent not found")
    try:
        files = AgentWorkspaceService(db).workspace_tree(agent)
    except AgentWorkspaceError as exc:
        raise HTTPException(400, str(exc)) from exc
    return [AgentWorkspaceFileOut(path=item.path, type=item.type, size=item.size) for item in files]


@router.patch("/agents/{agent_id}", response_model=NativeAgentOut)
def update_agent(
    agent_id: str,
    body: NativeAgentPatch,
    project: Project = Depends(require_write_access),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> NativeAgentOut:
    try:
        row = NativeAgentService(db).update_agent(
            agent_id,
            project_id=project.id,
            user_id=user.id,
            patch=body.model_dump(exclude_unset=True),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if row is None:
        raise HTTPException(404, "native agent not found")
    return _agent_out(row)


@router.delete("/agents/{agent_id}", status_code=204)
def delete_agent(
    agent_id: str,
    project: Project = Depends(require_write_access),
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> None:
    NativeAgentService(db).delete_agent(agent_id, project_id=project.id, user_id=user.id)

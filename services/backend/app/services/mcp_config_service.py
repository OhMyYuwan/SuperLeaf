"""User-scoped MCP configuration and runtime resolution."""

from __future__ import annotations

from datetime import datetime
import json
from typing import Any

from sqlalchemy.orm import Session

from ..models import NativeMcpServer
from ..secrets_vault import decrypt, encrypt
from .mcp_catalog_service import McpCatalogError, McpCatalogService


class McpConfigService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.catalog = McpCatalogService()

    def list_servers(self, *, user_id: str) -> list[NativeMcpServer]:
        return (
            self.db.query(NativeMcpServer)
            .filter(NativeMcpServer.user_id == user_id)
            .order_by(NativeMcpServer.updated_at.desc())
            .all()
        )

    def get_server(self, server_id: str, *, user_id: str) -> NativeMcpServer | None:
        row = self.db.get(NativeMcpServer, server_id)
        if row is None or row.user_id != user_id:
            return None
        return row

    def ensure_preset_server(
        self,
        preset_id: str,
        *,
        user_id: str,
        env: dict[str, str] | None = None,
    ) -> NativeMcpServer:
        preset = self.catalog.preset(preset_id)
        row = (
            self.db.query(NativeMcpServer)
            .filter(NativeMcpServer.user_id == user_id, NativeMcpServer.preset_id == preset_id)
            .first()
        )
        server = self.catalog.server_config_from_preset(preset, env={})
        if row is None:
            row = NativeMcpServer(
                user_id=user_id,
                preset_id=preset_id,
                source="catalog",
                name=str(preset.get("name") or preset_id),
                description=str(preset.get("description") or ""),
                transport=str(server.get("transport") or "stdio"),
                command=str(server.get("command") or ""),
                args=list(server.get("args") or []),
                env_enc=_encrypt_env(env or {}),
                allowed_tools=list(server.get("allowed_tools") or []),
                is_enabled=True,
            )
            self.db.add(row)
        else:
            row.source = "catalog"
            row.name = row.name or str(preset.get("name") or preset_id)
            row.description = row.description or str(preset.get("description") or "")
            row.transport = row.transport or str(server.get("transport") or "stdio")
            row.command = row.command or str(server.get("command") or "")
            row.args = row.args or list(server.get("args") or [])
            row.allowed_tools = row.allowed_tools or list(server.get("allowed_tools") or [])
            if env is not None:
                row.env_enc = _encrypt_env(env)
            row.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(row)
        return row

    def create_custom_server(
        self,
        *,
        user_id: str,
        name: str,
        description: str = "",
        transport: str = "stdio",
        command: str,
        args: list[str],
        env: dict[str, str],
        allowed_tools: list[str],
        is_enabled: bool = True,
    ) -> NativeMcpServer:
        if not command.strip():
            raise ValueError("MCP command 不能为空")
        row = NativeMcpServer(
            user_id=user_id,
            preset_id="",
            source="custom",
            name=name.strip() or command.strip(),
            description=description.strip(),
            transport=transport.strip() or "stdio",
            command=command.strip(),
            args=[str(item) for item in args if str(item).strip()],
            env_enc=_encrypt_env(env),
            allowed_tools=[str(item).strip() for item in allowed_tools if str(item).strip()],
            is_enabled=is_enabled,
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row

    def update_server(
        self,
        server_id: str,
        *,
        user_id: str,
        patch: dict[str, Any],
    ) -> NativeMcpServer | None:
        row = self.get_server(server_id, user_id=user_id)
        if row is None:
            return None
        for key in ("name", "description", "transport", "command", "args", "allowed_tools", "is_enabled"):
            if key in patch and patch[key] is not None:
                setattr(row, key, patch[key])
        if "env" in patch and patch["env"] is not None:
            row.env_enc = _encrypt_env(dict(patch["env"] or {}))
        row.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(row)
        return row

    def delete_server(self, server_id: str, *, user_id: str) -> bool:
        row = self.get_server(server_id, user_id=user_id)
        if row is None:
            return False
        self.db.delete(row)
        self.db.commit()
        return True

    def mark_probe(self, server_id: str, *, user_id: str, status: str, detail: str) -> NativeMcpServer | None:
        row = self.get_server(server_id, user_id=user_id)
        if row is None:
            return None
        row.status = status
        row.status_detail = detail
        row.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(row)
        return row

    def to_runtime_server(self, row: NativeMcpServer) -> dict[str, Any]:
        return {
            "id": row.id,
            "name": row.name or row.preset_id or row.id,
            "enabled": row.is_enabled,
            "transport": row.transport or "stdio",
            "command": row.command,
            "args": list(row.args or []),
            "env": decrypt_env(row.env_enc),
            "allowed_tools": list(row.allowed_tools or []),
        }

    def default_server_for_preset(self, preset_id: str) -> dict[str, Any]:
        preset = self.catalog.preset(preset_id)
        return self.catalog.server_config_from_preset(preset)

    def resolve_runtime_config(self, *, user_id: str, runtime_config: dict[str, Any] | None) -> dict[str, Any]:
        config = dict(runtime_config or {})
        servers: list[dict[str, Any]] = []
        seen: set[str] = set()

        for item in config.get("mcp_servers", []) if isinstance(config.get("mcp_servers"), list) else []:
            if isinstance(item, dict):
                ident = str(item.get("id") or item.get("name") or "")
                if ident:
                    seen.add(ident)
                servers.append(item)

        for server_id in _string_list(config.get("mcp_server_ids")):
            row = self.get_server(server_id, user_id=user_id)
            if row is None or not row.is_enabled:
                continue
            if row.preset_id and row.preset_id in seen:
                continue
            runtime = self.to_runtime_server(row)
            if runtime["id"] in seen:
                continue
            seen.add(runtime["id"])
            if row.preset_id:
                seen.add(row.preset_id)
            servers.append(runtime)

        for preset_id in _string_list(config.get("mcp_preset_ids")):
            if preset_id in seen:
                continue
            configured = (
                self.db.query(NativeMcpServer)
                .filter(NativeMcpServer.user_id == user_id, NativeMcpServer.preset_id == preset_id)
                .first()
            )
            if configured is not None:
                if not configured.is_enabled:
                    continue
                runtime = self.to_runtime_server(configured)
            else:
                try:
                    runtime = self.default_server_for_preset(preset_id)
                except McpCatalogError:
                    continue
            if runtime["id"] in seen:
                continue
            seen.add(runtime["id"])
            seen.add(preset_id)
            servers.append(runtime)

        config["mcp_servers"] = servers
        return config


def decrypt_env(env_enc: str) -> dict[str, str]:
    if not env_enc:
        return {}
    try:
        payload = json.loads(decrypt(env_enc))
    except Exception:  # noqa: BLE001
        return {}
    if not isinstance(payload, dict):
        return {}
    return {str(key): str(value) for key, value in payload.items() if str(key).strip() and str(value).strip()}


def env_keys(env_enc: str) -> list[str]:
    return sorted(decrypt_env(env_enc).keys())


def _encrypt_env(env: dict[str, str]) -> str:
    clean = {str(key): str(value) for key, value in env.items() if str(key).strip() and str(value).strip()}
    if not clean:
        return ""
    return encrypt(json.dumps(clean, ensure_ascii=False, sort_keys=True))


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]

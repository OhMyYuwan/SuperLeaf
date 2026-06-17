"""Runtime configuration via env or defaults.

Only minimal settings here; per-provider credentials live in the DB so they
can be edited from the settings UI without restarting the process.
"""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _resolve_env_file() -> str:
    """Find .env file with fallback chain.

    Priority:
      1. .env in current working directory (Docker / deployment)
      2. .env in monorepo root (local dev: services/backend/ → ../../.env)
    """
    cwd_env = Path.cwd() / ".env"
    if cwd_env.is_file():
        return str(cwd_env)
    # settings.py is at <root>/services/backend/app/settings.py
    root_env = Path(__file__).resolve().parents[3] / ".env"
    if root_env.is_file():
        return str(root_env)
    return str(cwd_env)  # default; pydantic will ignore if missing


class Settings(BaseSettings):
    # The legacy YLW_ prefix and ~/.yuwanlab data dir are intentionally kept so
    # existing local deployments survive the SuperLeaf rename without migration.
    model_config = SettingsConfigDict(
        env_prefix="YLW_",
        env_file=_resolve_env_file(),
        extra="ignore",
    )

    database_url: str = Field(default="")
    data_dir: Path = Field(default=Path.home() / ".yuwanlab")

    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://localhost:5174",
            "http://127.0.0.1:5173",
        ]
    )
    # Optional explicit CORS regex for trusted deployments that need patterns.
    cors_origin_regex: str = ""
    # Local/LAN dev convenience is intentionally opt-in because CORS allows
    # credentials and broad private origins can read authenticated responses.
    dev_cors_private_origins_enabled: bool = False
    dev_cors_private_origin_regex: ClassVar[str] = (
        r"^http://("
        r"localhost|127\.0\.0\.1|"
        r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
        r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|"
        r"192\.168\.\d{1,3}\.\d{1,3}"
        r")(:\d+)?$"
    )

    # 32-byte key for provider-credential encryption. Generated on first run if absent.
    secrets_key_file: str = "secrets.key"

    # Deployments default to closed self-registration. The first admin can be
    # created with a private bootstrap token, then the token is ignored after a
    # user exists. Local/dev deployments can opt back into public registration.
    public_registration: bool = False
    bootstrap_token: str = ""
    public_base_url: str = ""
    registration_invite_ttl_days: int = 7

    # Optional SMTP delivery for administrator-created registration invites.
    # If unset, invite links are still shown in the admin console for manual copy.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_tls: bool = True

    # Session cookie transport policy:
    # - auto: mark cookies Secure for HTTPS / X-Forwarded-Proto=https requests
    # - true: always mark cookies Secure for public HTTPS deployments
    # - false: allow local HTTP-only development
    cookie_secure: str = "auto"

    # Public deployments keep interactive API docs and raw OpenAPI closed by
    # default. Trusted local deployments can opt in with YLW_API_DOCS_ENABLED=true.
    api_docs_enabled: bool = False

    # Collaboration server (Node.js y-websocket)
    collab_server_url: str = "http://localhost:4444"
    collab_snapshot_interval_s: int = 30
    collab_token_lifetime_seconds: int = 300
    collab_internal_token: str = ""

    # Static Skill marketplace catalog. The default reads the official GitHub
    # repository main branch directly; GitHub Pages is optional for browsing.
    # Override with YLW_SKILL_MARKETPLACE_URL for local previews or private deployments.
    skill_marketplace_url: str = "https://raw.githubusercontent.com/OhMyYuwan/SuperLeaf.Skills/main/marketplace.json"

    # Static MCP catalog. Runtime reads the standalone SuperLeaf.MCPs repository
    # by default; local supports/ checkouts are only development/offline fallbacks.
    mcp_catalog_url: str = "https://raw.githubusercontent.com/OhMyYuwan/SuperLeaf.MCPs/main/catalog.json"

    # MCP execution policy. Public deployments keep user-defined MCP through
    # remote endpoints; stdio command execution is a Local Trusted opt-in.
    mcp_remote_enabled: bool = True
    mcp_stdio_enabled: bool = False
    mcp_inline_config_enabled: bool = False
    mcp_remote_private_networks_enabled: bool = False

    # Provider endpoints are normally called by backend HTTP clients, so public
    # deployments reject localhost/private network targets by default. Trusted
    # self-hosted deployments can opt in explicitly for local Dify/Nanobot.
    provider_private_networks_enabled: bool = False

    # Backend-native MCP server. This is an optional Agent command protocol
    # entrypoint mounted at /mcp; the normal backend API does not expose it by
    # default so Local Agent Host and Backend MCP stay separate lifecycles.
    mcp_server_enabled: bool = False
    mcp_session_ttl_seconds: int = 3600
    mcp_max_sessions: int = 256
    mcp_event_ttl_seconds: int = 3600
    mcp_event_max_per_stream: int = 200

    # NPX skill install policy. Public deployments keep this disabled; local /
    # trusted deployments can opt in to allow installing skills via npx recipes.
    skill_npx_install_enabled: bool = False

    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{self.data_dir / 'yuwanlab.db'}"

    def resolved_cors_origin_regex(self) -> str | None:
        if self.cors_origin_regex.strip():
            return self.cors_origin_regex.strip()
        if self.dev_cors_private_origins_enabled:
            return self.dev_cors_private_origin_regex
        return None

    def resolved_secrets_key_path(self) -> Path:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self.data_dir / self.secrets_key_file


settings = Settings()

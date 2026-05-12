"""Runtime configuration via env or defaults.

Only minimal settings here; per-provider credentials live in the DB so they
can be edited from the settings UI without restarting the process.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="YLW_", env_file=".env", extra="ignore")

    database_url: str = Field(default="")
    data_dir: Path = Field(default=Path.home() / ".yuwanlab")

    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://localhost:5174",
            "http://127.0.0.1:5173",
        ]
    )
    # Dev convenience: match any loopback / private-LAN origin on the Vite
    # dev port range so `vite --host` on a LAN IP still passes CORS.
    cors_origin_regex: str = (
        r"^http://("
        r"localhost|127\.0\.0\.1|"
        r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
        r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|"
        r"192\.168\.\d{1,3}\.\d{1,3}"
        r")(:\d+)?$"
    )

    # 32-byte key for provider-credential encryption. Generated on first run if absent.
    secrets_key_file: str = "secrets.key"

    # Collaboration server (Node.js y-websocket)
    collab_server_url: str = "http://localhost:4444"
    collab_snapshot_interval_s: int = 30

    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{self.data_dir / 'yuwanlab.db'}"

    def resolved_secrets_key_path(self) -> Path:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self.data_dir / self.secrets_key_file


settings = Settings()

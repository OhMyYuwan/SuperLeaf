"""Provider registry — manages saved provider configs.

Invariants:
- API keys never stored in plain text (Fernet).
- At most one active provider. Activating a provider deactivates others.
- `probe()` validates the endpoint/key pair and caches the result as status.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..models import CachedWorkflow, Provider
from ..secrets_vault import decrypt, encrypt
from .dify_client import DifyClient, DifyError
from .nanobot_client import NanobotClient, NanobotError


class ProviderService:
    def __init__(self, db: Session) -> None:
        self.db = db

    # --- CRUD --------------------------------------------------------------

    def list_providers(self, *, user_id: str) -> list[Provider]:
        return list(
            self.db.query(Provider)
            .filter(Provider.user_id == user_id)
            .order_by(Provider.created_at.asc())
            .all()
        )

    def get(self, provider_id: str, *, user_id: str | None = None) -> Provider | None:
        p = self.db.get(Provider, provider_id)
        if p is None:
            return None
        if user_id is not None and p.user_id != user_id:
            return None
        return p

    def get_active(self, *, user_id: str) -> Provider | None:
        return (
            self.db.query(Provider)
            .filter(Provider.is_active.is_(True), Provider.user_id == user_id)
            .first()
        )

    def create(
        self,
        *,
        user_id: str,
        name: str,
        kind: str,
        endpoint: str,
        api_key: str,
        activate: bool = False,
    ) -> Provider:
        p = Provider(
            user_id=user_id,
            name=name,
            kind=kind,
            endpoint=self._normalize_endpoint(kind, endpoint),
            api_key_enc=encrypt(api_key),
        )
        self.db.add(p)
        self.db.flush()
        if activate:
            self._set_active(p.id, user_id=user_id)
        self.db.commit()
        self.db.refresh(p)
        return p

    def update(
        self,
        provider_id: str,
        *,
        user_id: str,
        name: str | None = None,
        endpoint: str | None = None,
        api_key: str | None = None,
    ) -> Provider | None:
        p = self.get(provider_id, user_id=user_id)
        if p is None:
            return None
        if name is not None and name != p.name:
            p.name = name
            # Nanobot: 1 provider = 1 agent, agent name === provider name.
            # Cascade the rename so the UI doesn't need a re-probe to refresh.
            if p.kind == "nanobot":
                for cw in (
                    self.db.query(CachedWorkflow)
                    .filter(CachedWorkflow.provider_id == p.id)
                    .all()
                ):
                    cw.name = name
        if endpoint is not None:
            p.endpoint = self._normalize_endpoint(p.kind, endpoint)
        if api_key:  # only rotate if non-empty
            p.api_key_enc = encrypt(api_key)
        p.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(p)
        return p

    def delete(self, provider_id: str, *, user_id: str) -> bool:
        p = self.get(provider_id, user_id=user_id)
        if p is None:
            return False
        self.db.delete(p)
        self.db.commit()
        return True

    def activate(self, provider_id: str, *, user_id: str) -> Provider | None:
        p = self.get(provider_id, user_id=user_id)
        if p is None:
            return None
        self._set_active(provider_id, user_id=user_id)
        self.db.commit()
        self.db.refresh(p)
        return p

    def _set_active(self, provider_id: str, *, user_id: str) -> None:
        for p in (
            self.db.query(Provider).filter(Provider.user_id == user_id).all()
        ):
            p.is_active = p.id == provider_id

    # --- Probe + sync ------------------------------------------------------

    async def probe(self, provider_id: str, *, user_id: str) -> Provider | None:
        p = self.get(provider_id, user_id=user_id)
        if p is None:
            return None

        if p.kind == "native":
            try:
                models = await self._list_openai_models(p)
                p.status = "ok"
                p.status_detail = f"原生 Agent Provider 配置完整 · {len(models)} 个模型"
                p.meta = {
                    **(p.meta or {}),
                    "kind": "native",
                    "model_count": len(models),
                    "model_ids": [m.id for m in models],
                    "models": [
                        {"id": m.id, "name": m.name, "description": m.description}
                        for m in models
                    ],
                    "models_scanned_at": datetime.utcnow().isoformat(),
                }
            except NanobotError as e:
                p.status = "error"
                p.status_detail = f"HTTP {e.status}: {e.detail or '(empty body)'}"[:512]
            except Exception as e:  # network errors etc.
                p.status = "error"
                p.status_detail = f"{type(e).__name__}: {e}"[:512] or f"{type(e).__name__}: (no message)"
            p.updated_at = datetime.utcnow()
            self.db.commit()
            self.db.refresh(p)
            return p

        client = self._make_client(p)
        try:
            if p.kind == "nanobot":
                info = await client.probe()
                # One provider == one Agent. The user-assigned provider name is
                # the Agent's identity; the underlying model ids are just
                # implementation detail (stored in meta for diagnostics). We
                # default external_id to the first reported model; callers can
                # override later via provider.meta if needed.
                primary_model_id = info.models[0].id if info.models else ""
                primary_model_desc = info.models[0].description if info.models else ""
                self._sync_cached_workflows(
                    p,
                    (
                        [
                            {
                                "external_id": primary_model_id,
                                "name": p.name,
                                "description": primary_model_desc,
                                "kind": "nanobot",
                                "tags": _tags_from_raw(info.models[0].raw) if info.models else [],
                                "raw": info.models[0].raw if info.models else {},
                            }
                        ]
                        if primary_model_id
                        else []
                    ),
                )
                p.status = "ok" if primary_model_id else "error"
                if primary_model_id:
                    p.status_detail = f"{info.name} · model: {primary_model_id}"
                else:
                    p.status_detail = f"{info.name} 没有可用模型"
                p.meta = {
                    **(p.meta or {}),
                    "kind": "nanobot",
                    "provider_name": info.name,
                    "model_count": len(info.models),
                    "model_ids": [m.id for m in info.models],
                    "primary_model_id": primary_model_id,
                }
            else:
                info = await client.probe()
                p.status = "ok"
                p.status_detail = f"{info.mode} · {info.name}"
                p.meta = {**(p.meta or {}), "mode": info.mode, "app_name": info.name}
                self._sync_cached_workflows(
                    p,
                    [
                        {
                            "external_id": provider_id,  # Dify app is 1:1 with the API key, reuse id
                            "name": info.name,
                            "description": info.description,
                            "kind": info.mode if info.mode in ("workflow", "chatflow", "agent-chat") else "workflow",
                            "tags": info.tags,
                            "raw": {"mode": info.mode},
                        }
                    ],
                )
        except DifyError as e:
            p.status = "error"
            p.status_detail = f"HTTP {e.status}: {e.detail or '(empty body)'}"[:512]
        except NanobotError as e:
            p.status = "error"
            p.status_detail = f"HTTP {e.status}: {e.detail or '(empty body)'}"[:512]
        except Exception as e:  # network errors etc.
            import traceback

            traceback.print_exc()
            p.status = "error"
            p.status_detail = f"{type(e).__name__}: {e}"[:512] or f"{type(e).__name__}: (no message)"
        p.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(p)
        return p

    async def list_models(self, provider_id: str, *, user_id: str) -> list[dict[str, str]] | None:
        p = self.get(provider_id, user_id=user_id)
        if p is None:
            return None
        if p.kind not in ("native", "nanobot"):
            return []
        models = await self._list_openai_models(p)
        p.meta = {
            **(p.meta or {}),
            "model_count": len(models),
            "model_ids": [m.id for m in models],
            "models": [
                {"id": m.id, "name": m.name, "description": m.description}
                for m in models
            ],
            "models_scanned_at": datetime.utcnow().isoformat(),
        }
        p.status = "ok"
        p.status_detail = f"已扫描 {len(models)} 个模型"
        p.updated_at = datetime.utcnow()
        self.db.commit()
        return [
            {
                "id": model.id,
                "name": model.name,
                "description": model.description,
            }
            for model in models
        ]

    # --- Helpers ------------------------------------------------------------

    async def _list_openai_models(self, provider: Provider) -> list:
        api_key = decrypt(provider.api_key_enc)
        client = NanobotClient(endpoint=provider.endpoint, api_key=api_key, timeout=20.0)
        return await client.list_models()

    def make_client(self, provider: Provider) -> DifyClient | NanobotClient:
        return self._make_client(provider)

    def _make_client(self, provider: Provider) -> DifyClient | NanobotClient:
        endpoint = self._normalize_endpoint(provider.kind, provider.endpoint)
        api_key = decrypt(provider.api_key_enc)
        if provider.kind == "native":
            raise ValueError("native provider does not use external workflow probe")
        if provider.kind == "nanobot":
            return NanobotClient(endpoint=endpoint, api_key=api_key)
        return DifyClient(endpoint=endpoint, api_key=api_key)

    def _normalize_endpoint(self, kind: str, endpoint: str) -> str:
        cleaned = endpoint.rstrip("/")
        if kind == "nanobot" and cleaned.endswith("/v1"):
            cleaned = cleaned[:-3].rstrip("/")
        return cleaned

    def _sync_cached_workflows(self, provider: Provider, entries: list[dict[str, Any]]) -> None:
        self.db.query(CachedWorkflow).filter(CachedWorkflow.provider_id == provider.id).delete(
            synchronize_session=False
        )
        for entry in entries:
            external_id = str(entry["external_id"])
            cw = CachedWorkflow(
                id=f"{provider.id}:{external_id}",
                user_id=provider.user_id,
                provider_id=provider.id,
                external_id=external_id,
                name=str(entry["name"]),
                description=str(entry.get("description") or ""),
                kind=str(entry.get("kind") or "workflow"),
                tags=list(entry.get("tags") or []),
                raw=entry.get("raw") or {},
                last_synced_at=datetime.utcnow(),
            )
            self.db.add(cw)


def _tags_from_raw(raw: dict[str, Any]) -> list[str]:
    value = raw.get("tags")
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    return []

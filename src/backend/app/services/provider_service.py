"""Provider registry — manages saved Dify / Claude provider configs.

Invariants:
- API keys never stored in plain text (Fernet).
- At most one active provider. Activating a provider deactivates others.
- `probe()` validates the endpoint/key pair and caches the result as status.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from ..models import CachedWorkflow, Provider
from ..secrets_vault import decrypt, encrypt
from .dify_client import DifyClient, DifyError


class ProviderService:
    def __init__(self, db: Session) -> None:
        self.db = db

    # --- CRUD --------------------------------------------------------------

    def list_providers(self) -> list[Provider]:
        return list(self.db.query(Provider).order_by(Provider.created_at.asc()).all())

    def get(self, provider_id: str) -> Provider | None:
        return self.db.get(Provider, provider_id)

    def get_active(self) -> Provider | None:
        return self.db.query(Provider).filter(Provider.is_active.is_(True)).first()

    def create(
        self,
        *,
        name: str,
        kind: str,
        endpoint: str,
        api_key: str,
        activate: bool = False,
    ) -> Provider:
        p = Provider(
            name=name,
            kind=kind,
            endpoint=endpoint.rstrip("/"),
            api_key_enc=encrypt(api_key),
        )
        self.db.add(p)
        self.db.flush()
        if activate:
            self._set_active(p.id)
        self.db.commit()
        self.db.refresh(p)
        return p

    def update(
        self,
        provider_id: str,
        *,
        name: str | None = None,
        endpoint: str | None = None,
        api_key: str | None = None,
    ) -> Provider | None:
        p = self.get(provider_id)
        if p is None:
            return None
        if name is not None:
            p.name = name
        if endpoint is not None:
            p.endpoint = endpoint.rstrip("/")
        if api_key:  # only rotate if non-empty
            p.api_key_enc = encrypt(api_key)
        p.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(p)
        return p

    def delete(self, provider_id: str) -> bool:
        p = self.get(provider_id)
        if p is None:
            return False
        self.db.delete(p)
        self.db.commit()
        return True

    def activate(self, provider_id: str) -> Provider | None:
        p = self.get(provider_id)
        if p is None:
            return None
        self._set_active(provider_id)
        self.db.commit()
        self.db.refresh(p)
        return p

    def _set_active(self, provider_id: str) -> None:
        for p in self.db.query(Provider).all():
            p.is_active = p.id == provider_id

    # --- Probe + sync ------------------------------------------------------

    async def probe(self, provider_id: str) -> Provider | None:
        p = self.get(provider_id)
        if p is None:
            return None
        client = self._make_client(p)
        try:
            info = await client.probe()
            p.status = "ok"
            p.status_detail = f"{info.mode} · {info.name}"
            p.meta = {**(p.meta or {}), "mode": info.mode, "app_name": info.name}
            # Sync a cached-workflow row for this provider so the UI has something to list.
            self._upsert_cached_workflow(
                provider=p,
                external_id=provider_id,  # Dify app is 1:1 with the API key, reuse id
                name=info.name,
                description=info.description,
                kind=info.mode if info.mode in ("workflow", "chatflow", "agent-chat") else "workflow",
                tags=info.tags,
                raw={"mode": info.mode},
            )
        except DifyError as e:
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

    # --- Helpers ------------------------------------------------------------

    def make_client(self, provider: Provider) -> DifyClient:
        return self._make_client(provider)

    def _make_client(self, provider: Provider) -> DifyClient:
        return DifyClient(endpoint=provider.endpoint, api_key=decrypt(provider.api_key_enc))

    def _upsert_cached_workflow(
        self,
        *,
        provider: Provider,
        external_id: str,
        name: str,
        description: str,
        kind: str,
        tags: list[str],
        raw: dict,
    ) -> CachedWorkflow:
        cw_id = f"{provider.id}:{external_id}"
        cw = self.db.get(CachedWorkflow, cw_id)
        if cw is None:
            cw = CachedWorkflow(
                id=cw_id,
                provider_id=provider.id,
                external_id=external_id,
                name=name,
                description=description,
                kind=kind,
                tags=tags,
                raw=raw,
            )
            self.db.add(cw)
        else:
            cw.name = name
            cw.description = description
            cw.kind = kind
            cw.tags = tags
            cw.raw = raw
            cw.last_synced_at = datetime.utcnow()
        return cw

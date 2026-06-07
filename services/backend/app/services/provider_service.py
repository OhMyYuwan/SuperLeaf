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
        transport: str | None = None,
        workspace_path: str | None = None,
        codex_model: str | None = None,
        codex_effort: str | None = None,
        codex_summary: str | None = None,
        codex_service_tier: str | None = None,
        codex_sandbox: str | None = None,
        codex_approval_policy: str | None = None,
        codex_prompt_mode: str | None = None,
        codex_tool_mode: str | None = None,
        codex_context_mode: str | None = None,
        claude_model: str | None = None,
        claude_prompt_mode: str | None = None,
        claude_tool_mode: str | None = None,
    ) -> Provider:
        meta: dict[str, Any] = {}
        if kind == "nanobot":
            meta["transport"] = transport or "backend"
        if kind == "codex-local":
            meta.update(
                _codex_meta_patch(
                    workspace_path=workspace_path,
                    codex_model=codex_model,
                    codex_effort=codex_effort,
                    codex_summary=codex_summary,
                    codex_service_tier=codex_service_tier,
                    codex_sandbox=codex_sandbox,
                    codex_approval_policy=codex_approval_policy,
                    codex_prompt_mode=codex_prompt_mode,
                    codex_tool_mode=codex_tool_mode,
                    codex_context_mode=codex_context_mode,
                )
            )
        if kind == "claude-local":
            meta.update(
                _claude_meta_patch(
                    workspace_path=workspace_path,
                    claude_model=claude_model,
                    claude_prompt_mode=claude_prompt_mode,
                    claude_tool_mode=claude_tool_mode,
                )
            )
        p = Provider(
            user_id=user_id,
            name=name,
            kind=kind,
            endpoint=self._normalize_endpoint(kind, endpoint),
            api_key_enc=encrypt(api_key),
            meta=meta,
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
        transport: str | None = None,
        workspace_path: str | None = None,
        codex_model: str | None = None,
        codex_effort: str | None = None,
        codex_summary: str | None = None,
        codex_service_tier: str | None = None,
        codex_sandbox: str | None = None,
        codex_approval_policy: str | None = None,
        codex_prompt_mode: str | None = None,
        codex_tool_mode: str | None = None,
        codex_context_mode: str | None = None,
        claude_model: str | None = None,
        claude_prompt_mode: str | None = None,
        claude_tool_mode: str | None = None,
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
        if transport is not None:
            if p.kind not in ("nanobot", "codex-local", "claude-local"):
                raise ValueError("transport can only be set for browser-local providers")
            p.meta = {**(p.meta or {}), "transport": transport}
        if workspace_path is not None:
            if p.kind not in ("codex-local", "claude-local"):
                raise ValueError("workspace_path can only be set for local browser Agent providers")
            p.meta = {**(p.meta or {}), "workspace_path": str(workspace_path or "").strip()}
        codex_patch = _codex_meta_patch(
            workspace_path=None,
            codex_model=codex_model,
            codex_effort=codex_effort,
            codex_summary=codex_summary,
            codex_service_tier=codex_service_tier,
            codex_sandbox=codex_sandbox,
            codex_approval_policy=codex_approval_policy,
            codex_prompt_mode=codex_prompt_mode,
            codex_tool_mode=codex_tool_mode,
            codex_context_mode=codex_context_mode,
            include_workspace=False,
        )
        if codex_patch:
            if p.kind != "codex-local":
                raise ValueError("Codex settings can only be set for Codex Local providers")
            p.meta = {**(p.meta or {}), **codex_patch}
        claude_patch = _claude_meta_patch(
            workspace_path=None,
            claude_model=claude_model,
            claude_prompt_mode=claude_prompt_mode,
            claude_tool_mode=claude_tool_mode,
            include_workspace=False,
        )
        if claude_patch:
            if p.kind != "claude-local":
                raise ValueError("Claude settings can only be set for Claude Local providers")
            p.meta = {**(p.meta or {}), **claude_patch}
        p.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(p)
        return p

    def delete(self, provider_id: str, *, user_id: str) -> bool:
        p = self.get(provider_id, user_id=user_id)
        if p is None:
            return False
        # NativeAgent.provider_id is a non-cascading FK, so deleting the
        # Provider would otherwise leave orphan agents that don't show up in
        # the UI (the list query INNER-JOINs Provider) but still occupy the
        # database. Clean them up explicitly. Local import avoids a circular
        # dep with native_agent_service.
        from .native_agent_service import NativeAgentService
        NativeAgentService(self.db).delete_agents_for_provider(provider_id, user_id=user_id)
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

        if p.kind == "nanobot" and _provider_transport(p) == "browser":
            model_count = int((p.meta or {}).get("model_count") or 0)
            p.status = "ok" if model_count > 0 else "unknown"
            p.status_detail = (
                f"浏览器直连 Nanobot · 已同步 {model_count} 个 Agent 条目"
                if model_count > 0
                else "浏览器直连 Nanobot · 请在前端测连并同步 Agent"
            )
            p.meta = {**(p.meta or {}), "transport": "browser"}
            p.updated_at = datetime.utcnow()
            self.db.commit()
            self.db.refresh(p)
            return p

        if p.kind == "codex-local":
            has_workspace = bool(str((p.meta or {}).get("workspace_path") or "").strip())
            self._sync_cached_workflows(
                p,
                [
                    {
                        "external_id": "codex",
                        "name": p.name,
                        "description": "Local Codex Agent via SuperLeaf Local Agent Host.",
                        "kind": "codex-local",
                        "tags": ["local", "codex"],
                        "raw": {"transport": "browser", "workspace_path_set": has_workspace},
                    }
                ],
            )
            p.status = "unknown"
            p.status_detail = (
                "浏览器本机 Codex · 请由前端 Local Agent Host 测连"
                if has_workspace
                else "浏览器本机 Codex · 请设置代码项目 workspace path"
            )
            p.meta = {**(p.meta or {}), "transport": "browser", "kind": "codex-local"}
            p.updated_at = datetime.utcnow()
            self.db.commit()
            self.db.refresh(p)
            return p

        if p.kind == "claude-local":
            has_workspace = bool(str((p.meta or {}).get("workspace_path") or "").strip())
            self._sync_cached_workflows(
                p,
                [
                    {
                        "external_id": "claude",
                        "name": p.name,
                        "description": "Local Claude Code via SuperLeaf Local Agent Host.",
                        "kind": "claude-local",
                        "tags": ["local", "claude"],
                        "raw": {"transport": "browser", "workspace_path_set": has_workspace},
                    }
                ],
            )
            p.status = "unknown"
            p.status_detail = (
                "浏览器本机 Claude · 请由前端 Local Agent Host 测连"
                if has_workspace
                else "浏览器本机 Claude · 请设置代码项目 workspace path"
            )
            p.meta = {**(p.meta or {}), "transport": "browser", "kind": "claude-local"}
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
        if p.kind not in ("native", "nanobot", "codex-local", "claude-local"):
            return []
        if p.kind == "codex-local":
            return [
                {
                    "id": "codex",
                    "name": p.name,
                    "description": "Local Codex Agent via SuperLeaf Local Agent Host.",
                }
            ]
        if p.kind == "claude-local":
            return [
                {
                    "id": "claude",
                    "name": p.name,
                    "description": "Local Claude Code via SuperLeaf Local Agent Host.",
                }
            ]
        if p.kind == "nanobot" and _provider_transport(p) == "browser":
            models = list((p.meta or {}).get("models") or [])
            return [
                {
                    "id": str(model.get("id") or ""),
                    "name": str(model.get("name") or model.get("id") or ""),
                    "description": str(model.get("description") or ""),
                }
                for model in models
                if str(model.get("id") or "").strip()
            ]
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

    def sync_browser_nanobot_models(
        self,
        provider_id: str,
        *,
        user_id: str,
        provider_name: str = "",
        models: list[dict[str, Any]],
        local_agent_host_endpoint: str = "",
    ) -> Provider | None:
        p = self.get(provider_id, user_id=user_id)
        if p is None:
            return None
        if p.kind != "nanobot":
            raise ValueError("provider is not Nanobot")
        normalized: list[dict[str, Any]] = []
        for item in models:
            ident = str(item.get("id") or "").strip()
            if not ident:
                continue
            normalized.append(
                {
                    "id": ident,
                    "name": str(item.get("name") or ident).strip() or ident,
                    "description": str(item.get("description") or ""),
                    "raw": item.get("raw") if isinstance(item.get("raw"), dict) else {},
                }
            )
        tool_count = _nanobot_superleaf_tool_count(normalized)
        tool_names = _nanobot_superleaf_tool_names(normalized)
        adapter_endpoint = (
            local_agent_host_endpoint.strip()
            or _nanobot_local_agent_host_endpoint(normalized)
        )
        adapter_mode = _nanobot_adapter_mode(normalized)
        adapter_source = _nanobot_adapter_source(normalized)
        self._sync_cached_workflows(
            p,
            [
                {
                    "external_id": item["id"],
                    "name": p.name,
                    "description": item["description"],
                    "kind": "nanobot",
                    "tags": _tags_from_raw(item["raw"]),
                    "raw": item["raw"],
                }
                for item in normalized
            ],
        )
        p.status = "ok" if normalized else "error"
        p.status_detail = (
            f"浏览器直连 Nanobot · 已同步 {len(normalized)} 个 Agent 条目"
            + (f" · SuperLeaf tools: {tool_count}" if tool_count else "")
            if normalized
            else "浏览器直连 Nanobot 未返回可用 Agent"
        )
        p.meta = {
            **(p.meta or {}),
            "transport": "browser",
            "provider_name": provider_name or p.name,
            "model_count": len(normalized),
            "model_ids": [item["id"] for item in normalized],
            "superleaf_tool_count": tool_count,
            "superleaf_tool_names": tool_names,
            "local_agent_host_endpoint": adapter_endpoint,
            "nanobot_adapter_endpoint": adapter_endpoint,
            "nanobot_adapter_status": "bound" if tool_count > 0 and adapter_endpoint else "not_detected",
            "nanobot_adapter_mode": adapter_mode,
            "nanobot_adapter_source": adapter_source,
            "models": [
                {
                    "id": item["id"],
                    "name": item["name"],
                    "description": item["description"],
                }
                for item in normalized
            ],
            "models_scanned_at": datetime.utcnow().isoformat(),
        }
        p.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(p)
        return p

    def sync_browser_codex_agent(
        self,
        provider_id: str,
        *,
        user_id: str,
        health: dict[str, Any] | None = None,
        models: list[dict[str, Any]] | None = None,
    ) -> Provider | None:
        p = self.get(provider_id, user_id=user_id)
        if p is None:
            return None
        if p.kind != "codex-local":
            raise ValueError("provider is not Codex Local")
        workspace_path = str((p.meta or {}).get("workspace_path") or "").strip()
        version = str((health or {}).get("codex_version") or "").strip()
        normalized_models = _normalize_codex_models(models or [])
        model_ids = [item["id"] for item in normalized_models]
        self._sync_cached_workflows(
            p,
            [
                {
                    "external_id": "codex",
                    "name": p.name,
                    "description": version or "Local Codex Agent.",
                    "kind": "codex-local",
                    "tags": ["local", "codex"],
                    "raw": {
                        "transport": "browser",
                        "health": health or {},
                        "workspace_path_set": bool(workspace_path),
                        "models": normalized_models,
                    },
                }
            ],
        )
        p.status = "ok" if (health or {}).get("status") == "ok" else "unknown"
        p.status_detail = (
            f"浏览器本机 Codex · {version}"
            if version
            else "浏览器本机 Codex · 已同步 Agent"
        )
        meta_patch: dict[str, Any] = {
            "transport": "browser",
            "kind": "codex-local",
            "provider_name": p.name,
            "codex_health": health or {},
            "models_scanned_at": datetime.utcnow().isoformat(),
        }
        if normalized_models:
            selected_model = str((p.meta or {}).get("codex_model") or "").strip()
            meta_patch.update(
                {
                    "model_count": len(normalized_models),
                    "model_ids": model_ids,
                    "models": [
                        {
                            "id": item["id"],
                            "name": item["name"],
                            "description": item["description"],
                            "raw": item["raw"],
                        }
                        for item in normalized_models
                    ],
                }
            )
            if selected_model and selected_model not in model_ids:
                meta_patch["codex_model"] = ""
        else:
            meta_patch.update(
                {
                    "model_count": 0,
                    "model_ids": [],
                    "models": [],
                }
            )
        p.meta = {
            **(p.meta or {}),
            **meta_patch,
        }
        self.db.commit()
        self.db.refresh(p)
        return p

    def sync_browser_claude_agent(
        self,
        provider_id: str,
        *,
        user_id: str,
        health: dict[str, Any] | None = None,
    ) -> Provider | None:
        p = self.get(provider_id, user_id=user_id)
        if p is None:
            return None
        if p.kind != "claude-local":
            raise ValueError("provider is not Claude Local")
        workspace_path = str((p.meta or {}).get("workspace_path") or "").strip()
        version = str((health or {}).get("claude_version") or "").strip()
        self._sync_cached_workflows(
            p,
            [
                {
                    "external_id": "claude",
                    "name": p.name,
                    "description": version or "Local Claude Code Agent.",
                    "kind": "claude-local",
                    "tags": ["local", "claude"],
                    "raw": {
                        "transport": "browser",
                        "health": health or {},
                        "workspace_path_set": bool(workspace_path),
                    },
                }
            ],
        )
        p.status = "ok" if (health or {}).get("status") == "ok" else "unknown"
        p.status_detail = (
            f"浏览器本机 Claude · {version}"
            if version
            else "浏览器本机 Claude · 已同步 Agent"
        )
        p.meta = {
            **(p.meta or {}),
            "transport": "browser",
            "kind": "claude-local",
            "provider_name": p.name,
            "claude_health": health or {},
            "models_scanned_at": datetime.utcnow().isoformat(),
        }
        self.db.commit()
        self.db.refresh(p)
        return p

    # --- Helpers ------------------------------------------------------------

    async def _list_openai_models(self, provider: Provider) -> list:
        api_key = decrypt(provider.api_key_enc)
        client = NanobotClient(endpoint=provider.endpoint, api_key=api_key, timeout=20.0)
        return await client.list_models()

    def make_client(self, provider: Provider) -> DifyClient | NanobotClient:
        return self._make_client(provider)

    def _make_client(self, provider: Provider) -> DifyClient | NanobotClient:
        endpoint = self._normalize_endpoint(provider.kind, provider.endpoint)
        if provider.kind == "native":
            raise ValueError("native provider does not use external workflow probe")
        if provider.kind == "codex-local":
            raise ValueError(
                "Codex Local providers cannot be called by the backend; "
                "use the browser Codex transport endpoints"
            )
        if provider.kind == "claude-local":
            raise ValueError(
                "Claude Local providers cannot be called by the backend; "
                "use the browser Claude transport endpoints"
            )
        if provider.kind == "nanobot":
            if _provider_transport(provider) == "browser":
                raise ValueError(
                    "browser Nanobot providers cannot be called by the backend; "
                    "use the browser Nanobot transport endpoints"
                )
            api_key = decrypt(provider.api_key_enc)
            return NanobotClient(endpoint=endpoint, api_key=api_key)
        api_key = decrypt(provider.api_key_enc)
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


def _nanobot_superleaf_tool_count(items: list[dict[str, Any]]) -> int:
    for item in items:
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        value = raw.get("superleaf_tool_count")
        if isinstance(value, int) and value > 0:
            return value
        adapter = raw.get("tool_adapter")
        if isinstance(adapter, dict):
            nested = adapter.get("superleaf_mcp_tool_count")
            if isinstance(nested, int) and nested > 0:
                return nested
            adapter_meta = adapter.get("adapter")
            if isinstance(adapter_meta, dict):
                count = adapter_meta.get("tool_count")
                if isinstance(count, int) and count > 0:
                    return count
    return 0


def _nanobot_superleaf_tool_names(items: list[dict[str, Any]]) -> list[str]:
    for item in items:
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        value = raw.get("superleaf_tool_names")
        if isinstance(value, list):
            names = [str(name).strip() for name in value if str(name).strip()]
            if names:
                return names
        adapter = raw.get("tool_adapter")
        if isinstance(adapter, dict):
            adapter_meta = adapter.get("adapter")
            if isinstance(adapter_meta, dict) and isinstance(adapter_meta.get("tool_names"), list):
                names = [str(name).strip() for name in adapter_meta["tool_names"] if str(name).strip()]
                if names:
                    return names
    return []


def _nanobot_local_agent_host_endpoint(items: list[dict[str, Any]]) -> str:
    for item in items:
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        for key in ("local_agent_host_endpoint", "nanobot_adapter_endpoint", "adapter_endpoint"):
            value = str(raw.get(key) or "").strip()
            if value:
                return value
        adapter = raw.get("tool_adapter")
        if isinstance(adapter, dict):
            value = str(adapter.get("adapter_endpoint") or "").strip()
            if value:
                return value
    return ""


def _nanobot_adapter_mode(items: list[dict[str, Any]]) -> str:
    for item in items:
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        value = str(raw.get("nanobot_adapter_mode") or "").strip()
        if value:
            return value
        adapter = raw.get("tool_adapter")
        if isinstance(adapter, dict):
            nested = adapter.get("adapter")
            if isinstance(nested, dict):
                value = str(nested.get("mode") or "").strip()
                if value:
                    return value
    return ""


def _nanobot_adapter_source(items: list[dict[str, Any]]) -> str:
    for item in items:
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        value = str(raw.get("nanobot_adapter_source") or "").strip()
        if value:
            return value
        adapter = raw.get("tool_adapter")
        if isinstance(adapter, dict):
            value = str(adapter.get("adapter_source") or "").strip()
            if value:
                return value
    return ""


def _normalize_codex_models(models: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in models:
        ident = str(item.get("model") or item.get("id") or "").strip()
        if not ident or ident in seen:
            continue
        seen.add(ident)
        name = str(item.get("name") or item.get("model") or ident).strip() or ident
        description = str(item.get("description") or "")
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        raw_patch = {
            "model": str(item.get("model") or ident).strip() or ident,
            "hidden": bool(item.get("hidden")),
            "is_default": bool(item.get("is_default")),
            "default_reasoning_effort": str(item.get("default_reasoning_effort") or ""),
            "supported_reasoning_efforts": _string_list(item.get("supported_reasoning_efforts")),
            "service_tiers": item.get("service_tiers") if isinstance(item.get("service_tiers"), list) else [],
            "default_service_tier": str(item.get("default_service_tier") or ""),
        }
        normalized.append(
            {
                "id": ident,
                "name": name,
                "description": description,
                "raw": {**raw, **raw_patch},
            }
        )
    return normalized


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _provider_transport(provider: Provider) -> str:
    return str((provider.meta or {}).get("transport") or "backend").strip() or "backend"


def _codex_meta_patch(
    *,
    workspace_path: str | None = None,
    codex_model: str | None = None,
    codex_effort: str | None = None,
    codex_summary: str | None = None,
    codex_service_tier: str | None = None,
    codex_sandbox: str | None = None,
    codex_approval_policy: str | None = None,
    codex_prompt_mode: str | None = None,
    codex_tool_mode: str | None = None,
    codex_context_mode: str | None = None,
    include_workspace: bool = True,
) -> dict[str, Any]:
    if not include_workspace and all(
        value is None
        for value in (
            codex_model,
            codex_effort,
            codex_summary,
            codex_service_tier,
            codex_sandbox,
            codex_approval_policy,
            codex_prompt_mode,
            codex_tool_mode,
            codex_context_mode,
        )
    ):
        return {}
    patch: dict[str, Any] = {
        "transport": "browser",
        "kind": "codex-local",
    }
    if include_workspace:
        patch["workspace_path"] = str(workspace_path or "").strip()
    if codex_model is not None:
        patch["codex_model"] = str(codex_model or "").strip()
    if codex_effort is not None:
        patch["codex_effort"] = _codex_effort_choice(codex_effort)
    if codex_summary is not None:
        patch["codex_summary"] = _choice(codex_summary, {"none", "auto", "concise", "detailed"}, "none")
    if codex_service_tier is not None:
        patch["codex_service_tier"] = str(codex_service_tier or "").strip()
    if codex_sandbox is not None:
        patch["codex_sandbox"] = _choice(codex_sandbox, {"read-only", "workspace-write", "danger-full-access"}, "danger-full-access")
    if codex_approval_policy is not None:
        patch["codex_approval_policy"] = _choice(codex_approval_policy, {"never", "untrusted", "on-request", "on-failure"}, "on-request")
    if codex_prompt_mode is not None:
        patch["codex_prompt_mode"] = _choice(codex_prompt_mode, {"fast-edit", "full-agent"}, "fast-edit")
    if codex_tool_mode is not None:
        patch["codex_tool_mode"] = _choice(codex_tool_mode, {"mcp-first", "browser-preflight", "marker-only"}, "mcp-first")
    if codex_context_mode is not None:
        patch["codex_context_mode"] = _choice(codex_context_mode, {"legacy-blocks", "lease"}, "lease")
    patch.setdefault("codex_effort", "low")
    patch.setdefault("codex_summary", "none")
    patch.setdefault("codex_sandbox", "danger-full-access")
    patch.setdefault("codex_approval_policy", "on-request")
    patch.setdefault("codex_prompt_mode", "fast-edit")
    patch.setdefault("codex_tool_mode", "mcp-first")
    patch.setdefault("codex_context_mode", "lease")
    return patch


def _claude_meta_patch(
    *,
    workspace_path: str | None = None,
    claude_model: str | None = None,
    claude_prompt_mode: str | None = None,
    claude_tool_mode: str | None = None,
    include_workspace: bool = True,
) -> dict[str, Any]:
    if (
        not include_workspace
        and claude_model is None
        and claude_prompt_mode is None
        and claude_tool_mode is None
    ):
        return {}
    patch: dict[str, Any] = {
        "transport": "browser",
        "kind": "claude-local",
    }
    if include_workspace:
        patch["workspace_path"] = str(workspace_path or "").strip()
    if claude_model is not None:
        patch["claude_model"] = str(claude_model or "").strip()
    if claude_prompt_mode is not None:
        patch["claude_prompt_mode"] = _choice(claude_prompt_mode, {"fast-edit", "full-agent"}, "fast-edit")
    if claude_tool_mode is not None:
        patch["claude_tool_mode"] = _choice(claude_tool_mode, {"mcp-first", "browser-preflight", "marker-only"}, "mcp-first")
    patch.setdefault("claude_prompt_mode", "fast-edit")
    patch.setdefault("claude_tool_mode", "mcp-first")
    return patch


def _choice(value: str | None, allowed: set[str], default: str) -> str:
    cleaned = str(value or "").strip()
    return cleaned if cleaned in allowed else default


def _codex_effort_choice(value: str | None) -> str:
    cleaned = str(value or "").strip()
    if cleaned == "minimal":
        return "low"
    return cleaned if cleaned in {"none", "low", "medium", "high", "xhigh"} else "low"

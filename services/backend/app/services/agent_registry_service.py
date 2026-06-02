"""Resolver for runnable Agents.

Workflow graphs can reference either external CachedWorkflow rows or synthetic
native Agent ids (`native:{agent_id}`). This service centralizes ownership and
enabled-state checks so API validation and runtime dispatch agree.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import yaml
from sqlalchemy.orm import Session

from ..models import CachedWorkflow, NativeAgent, Provider
from .native_agent_runner import NativeSkillBlock

NATIVE_WORKFLOW_PREFIX = "native:"


@dataclass(slots=True)
class ResolvedAgent:
    source: str
    workflow_id: str
    provider: Provider
    cached_workflow: CachedWorkflow | None = None
    native_agent: NativeAgent | None = None


class AgentRegistryService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def resolve(
        self,
        agent_id: str,
        *,
        user_id: str,
        project_id: str | None = None,
        require_enabled: bool = True,
    ) -> ResolvedAgent | None:
        agent_id = str(agent_id or "").strip()
        if not agent_id:
            return None
        if agent_id.startswith(NATIVE_WORKFLOW_PREFIX):
            return self._resolve_native(
                agent_id,
                user_id=user_id,
                project_id=project_id,
                require_enabled=require_enabled,
            )
        return self._resolve_external(agent_id, user_id=user_id, require_enabled=require_enabled)

    def skill_blocks_for_native_agent(self, agent: NativeAgent, *, user_id: str) -> list[NativeSkillBlock]:
        """Scan the Agent's .agents/skills/ folder on disk for available Skills."""
        workspace = Path(agent.workspace_path) if agent.workspace_path else None
        skills_dir = workspace / ".agents" / "skills" if workspace else None
        if not skills_dir or not skills_dir.is_dir():
            return []

        out: list[NativeSkillBlock] = []
        seen: set[str] = set()
        for item in sorted(skills_dir.iterdir()):
            # Direct skill folder with SKILL.md
            if item.is_dir() and (item / "SKILL.md").is_file():
                folder_name = item.name
                if folder_name in seen:
                    continue
                seen.add(folder_name)
                meta = _read_skill_meta(item)
                out.append(
                    NativeSkillBlock(
                        id=folder_name,
                        name=meta.get("name") or folder_name,
                        version=meta.get("version", 1),
                        source="workspace",
                        content="",
                        aliases=[folder_name],
                        description=meta.get("description", ""),
                        tags=meta.get("tags", []),
                        folder_path=f"skills/{folder_name}",
                    )
                )
            # .skillref.json pointing to a project skill cache
            elif item.is_file() and item.suffix == ".json" and item.stem.endswith(".skillref"):
                try:
                    ref = json.loads(item.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                target = ref.get("target_path", "")
                folder_name = ref.get("folder_name", item.stem.replace(".skillref", ""))
                if not target or not Path(target).is_dir():
                    continue
                if folder_name in seen:
                    continue
                seen.add(folder_name)
                meta = _read_skill_meta(Path(target))
                out.append(
                    NativeSkillBlock(
                        id=folder_name,
                        name=meta.get("name") or folder_name,
                        version=meta.get("version", 1),
                        source="project",
                        content="",
                        aliases=[folder_name],
                        description=meta.get("description", ""),
                        tags=meta.get("tags", []),
                        folder_path=f"skills/{item.name}",
                    )
                )
        return out

    def _resolve_external(
        self,
        agent_id: str,
        *,
        user_id: str,
        require_enabled: bool,
    ) -> ResolvedAgent | None:
        cached = self.db.get(CachedWorkflow, agent_id)
        if cached is None or cached.user_id != user_id:
            return None
        if require_enabled and cached.is_disabled:
            return None
        provider = self.db.get(Provider, cached.provider_id)
        if provider is None or provider.user_id != user_id:
            return None
        return ResolvedAgent(
            source="external",
            workflow_id=agent_id,
            provider=provider,
            cached_workflow=cached,
        )

    def _resolve_native(
        self,
        workflow_id: str,
        *,
        user_id: str,
        project_id: str | None,
        require_enabled: bool,
    ) -> ResolvedAgent | None:
        native_id = workflow_id.removeprefix(NATIVE_WORKFLOW_PREFIX)
        agent = self.db.get(NativeAgent, native_id)
        if agent is None or agent.owner_user_id != user_id:
            return None
        if project_id is not None and agent.project_id != project_id:
            return None
        if require_enabled and not agent.is_enabled:
            return None
        provider = self.db.get(Provider, agent.provider_id)
        if provider is None or provider.user_id != user_id or provider.kind != "native":
            return None
        return ResolvedAgent(
            source="native",
            workflow_id=workflow_id,
            provider=provider,
            native_agent=agent,
        )


def _read_skill_meta(folder: Path) -> dict:
    """Read skill.yaml metadata from a skill folder. Returns {} if missing."""
    yaml_path = folder / "skill.yaml"
    if not yaml_path.is_file():
        return {}
    try:
        data = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return {}
    if not isinstance(data, dict):
        return {}
    # Normalize version to int
    raw_ver = data.get("version", 1)
    try:
        data["version"] = int(str(raw_ver).split(".")[0])
    except (ValueError, TypeError):
        data["version"] = 1
    # Normalize tags
    tags = data.get("tags", [])
    if not isinstance(tags, list):
        tags = []
    data["tags"] = [str(t) for t in tags if t]
    return data


def _unique_non_empty(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = str(value or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out

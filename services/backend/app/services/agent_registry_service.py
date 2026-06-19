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

    def skill_blocks_for_project(self, project_id: str, *, user_id: str) -> list[NativeSkillBlock]:
        """Scan the project's inline agent workspace for available Skills.

        Used by inline agent nodes in workflows.
        """
        from .agent_workspace_service import AgentWorkspaceService

        svc = AgentWorkspaceService(self.db)
        root = svc.root_for(user_id=user_id, project_id=project_id, agent_id="inline")
        return _skill_blocks_from_dir(root / ".agents" / "skills")

    def skill_blocks_for_inline_workflow_node(
        self,
        *,
        user_id: str,
        project_id: str,
        workflow_id: str,
        node_id: str,
    ) -> list[NativeSkillBlock]:
        from .agent_workspace_service import AgentWorkspaceService

        svc = AgentWorkspaceService(self.db)
        root = svc.root_for_inline_workflow_node(
            user_id=user_id,
            project_id=project_id,
            workflow_id=workflow_id,
            node_id=node_id,
        )
        return _skill_blocks_from_dir(root / ".agents" / "skills")

    def skill_blocks_for_native_agent(self, agent: NativeAgent, *, user_id: str) -> list[NativeSkillBlock]:
        """Scan the Agent's .agents/skills/ folder on disk for available Skills."""
        workspace = Path(agent.workspace_path) if agent.workspace_path else None
        skills_dir = workspace / ".agents" / "skills" if workspace else None
        return _skill_blocks_from_dir(skills_dir)

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


def _skill_blocks_from_dir(skills_dir: Path | None) -> list[NativeSkillBlock]:
    if not skills_dir or not skills_dir.is_dir():
        return []

    out: list[NativeSkillBlock] = []
    seen: set[str] = set()
    for item in sorted(skills_dir.iterdir()):
        if _is_macos_metadata_file(item):
            continue
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
        elif item.is_file() and item.suffix == ".json" and item.stem.endswith(".skillref"):
            block = _skill_block_from_ref(item, seen)
            if block is not None:
                out.append(block)
    return out


def _skill_block_from_ref(item: Path, seen: set[str]) -> NativeSkillBlock | None:
    try:
        ref = json.loads(item.read_text(encoding="utf-8", errors="replace"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    target = ref.get("target_path", "")
    folder_name = ref.get("folder_name", item.stem.replace(".skillref", ""))
    if not target or not Path(target).is_dir():
        return None
    if folder_name in seen:
        return None
    seen.add(folder_name)
    target_path = Path(target)
    meta = _read_skill_meta(target_path)
    manifest = ref.get("manifest") if isinstance(ref.get("manifest"), dict) else {}
    aliases = [folder_name]
    alias = str(ref.get("alias") or "").strip()
    if alias and alias not in aliases:
        aliases.append(alias)
    return NativeSkillBlock(
        id=folder_name,
        name=str(ref.get("display_name") or manifest.get("name") or meta.get("name") or folder_name),
        version=manifest.get("version") or meta.get("version", 1),
        source=str(ref.get("source") or ref.get("storage_scope") or "project"),
        content="",
        aliases=aliases,
        description=str(ref.get("description") or manifest.get("description") or meta.get("description") or ""),
        tags=manifest.get("tags") or meta.get("tags", []),
        content_hash=str(ref.get("checksum") or manifest.get("checksum") or ""),
        folder_path=f"skills/{item.name}",
    )


def _read_skill_meta(folder: Path) -> dict:
    """Read skill metadata: try skill.yaml, fall back to SKILL.md front matter."""
    # 1) Try skill.yaml
    yaml_path = folder / "skill.yaml"
    if yaml_path.is_file():
        try:
            data = yaml.safe_load(yaml_path.read_text(encoding="utf-8", errors="replace"))
            if isinstance(data, dict):
                return _normalize_meta(data)
        except (OSError, UnicodeDecodeError, yaml.YAMLError):
            pass

    # 2) Fall back to SKILL.md front matter
    skill_md = folder / "SKILL.md"
    if skill_md.is_file():
        try:
            text = skill_md.read_text(encoding="utf-8", errors="replace")
            if text.startswith("---"):
                end = text.find("---", 3)
                if end > 0:
                    front = yaml.safe_load(text[3:end])
                    if isinstance(front, dict):
                        return _normalize_meta(front)
        except (OSError, yaml.YAMLError):
            pass

    import logging

    logging.getLogger(__name__).warning("No metadata found for skill folder: %s", folder.name)
    return {}


def _is_macos_metadata_file(path: Path) -> bool:
    return path.name == ".DS_Store" or path.name.startswith("._")


def _normalize_meta(data: dict) -> dict:
    """Normalize skill metadata fields."""
    raw_ver = data.get("version", 1)
    try:
        data["version"] = int(str(raw_ver).split(".")[0])
    except (ValueError, TypeError):
        data["version"] = 1
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

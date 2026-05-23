"""Resolver for runnable Agents.

Workflow graphs can reference either external CachedWorkflow rows or synthetic
native Agent ids (`native:{agent_id}`). This service centralizes ownership and
enabled-state checks so API validation and runtime dispatch agree.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from ..models import CachedWorkflow, NativeAgent, Provider, Skill
from .native_agent_runner import NativeSkillBlock
from .skill_content_crypto import decrypt_skill_content


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
        out: list[NativeSkillBlock] = []
        for skill_id in agent.skill_ids or []:
            skill = self.db.get(Skill, str(skill_id))
            if skill is None:
                continue
            if skill.visibility not in ("system", "public") and skill.owner_user_id != user_id:
                continue
            content = decrypt_skill_content(skill.content)
            if not content.strip():
                continue
            out.append(
                NativeSkillBlock(
                    name=skill.public_name or skill.name,
                    version=skill.version,
                    source=skill.source,
                    content=content,
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

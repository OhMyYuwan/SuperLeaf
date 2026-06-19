"""Native Agent registry service.

Phase 1 only: CRUD/configuration for backend-run native Agents, encrypted
credentials, and Skills. Runtime execution is intentionally out of scope.
"""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import shutil
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models import (
    Doc,
    GitHubAccount,
    NativeAgent,
    NativeAgentCredential,
    NativeAgentSkillInstall,
    Project,
    Provider,
    Skill,
    SkillHidden,
)
from ..schemas import NativeAgentSkillRecipeIn
from ..secrets_vault import encrypt
from ..settings import settings
from .agent_workspace_service import AgentWorkspaceError, AgentWorkspaceService
from .project_fs_service import ProjectFsService
from .project_member_service import ProjectMemberService
from .skill_content_crypto import decrypt_skill_content, encrypt_skill_content
from .skill_npx_installer import SkillInstallRecipe, SkillNpxInstaller, SkillNpxInstallError
from .skill_release_cache_service import SkillReleaseCacheService
from .skill_recipe_metadata import (
    build_npx_install_command,
    build_recipe_tags,
    is_direct_skill_source,
    recipe_meta_from_tags,
)

SYSTEM_SKILLS = [
    {
        "name": "annotation-review",
        "description": "读取传入的批注上下文，给出聚焦、可执行的修改建议。",
        "content": (
            "你是项目批注审阅助手。只能基于调用方传入的批注、引用片段和讨论内容工作，"
            "不直接读取或修改项目文件。输出应简洁、可执行，并明确指出需要用户确认的部分。"
        ),
        "tags": ["annotation", "review"],
    },
    {
        "name": "plan-breakdown",
        "description": "把项目需求拆解为可执行计划、风险点和验收标准。",
        "content": (
            "你是项目计划助手。只能使用调用方传入的需求、项目元信息和显式上下文。"
            "输出计划时包含阶段、依赖、风险和验收标准，避免假设未传入的文件内容。"
        ),
        "tags": ["planning", "project"],
    },
    {
        "name": "workflow-draft",
        "description": "根据传入目标生成工作流草稿和节点说明。",
        "content": (
            "你是工作流草稿助手。根据调用方提供的目标、输入输出约束和可用节点，"
            "生成清晰的工作流草案。不得直接访问项目文件，必须要求调用方提供必要上下文。"
        ),
        "tags": ["workflow", "draft"],
    },
]


class NativeAgentService:
    def __init__(self, db: Session) -> None:
        self.db = db

    # --- credentials -----------------------------------------------------

    def list_credentials(self, *, user_id: str) -> list[NativeAgentCredential]:
        return (
            self.db.query(NativeAgentCredential)
            .filter(NativeAgentCredential.user_id == user_id)
            .order_by(NativeAgentCredential.created_at.asc())
            .all()
        )

    def get_credential(self, credential_id: str, *, user_id: str) -> NativeAgentCredential | None:
        row = self.db.get(NativeAgentCredential, credential_id)
        if row is None or row.user_id != user_id:
            return None
        return row

    def create_credential(
        self,
        *,
        user_id: str,
        name: str,
        base_url: str,
        api_key: str,
        runtime_kind: str,
        default_model: str,
    ) -> NativeAgentCredential:
        row = NativeAgentCredential(
            user_id=user_id,
            name=name.strip(),
            base_url=base_url.rstrip("/"),
            api_key_enc=encrypt(api_key),
            runtime_kind=runtime_kind.strip() or "openai-agents-sdk",
            default_model=default_model.strip(),
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row

    def update_credential(
        self,
        credential_id: str,
        *,
        user_id: str,
        name: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        runtime_kind: str | None = None,
        default_model: str | None = None,
    ) -> NativeAgentCredential | None:
        row = self.get_credential(credential_id, user_id=user_id)
        if row is None:
            return None
        if name is not None:
            row.name = name.strip()
        if base_url is not None:
            row.base_url = base_url.rstrip("/")
        if api_key:
            row.api_key_enc = encrypt(api_key)
        if runtime_kind is not None:
            row.runtime_kind = runtime_kind.strip() or "openai-agents-sdk"
        if default_model is not None:
            row.default_model = default_model.strip()
        row.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(row)
        return row

    def delete_credential(self, credential_id: str, *, user_id: str) -> bool:
        row = self.get_credential(credential_id, user_id=user_id)
        if row is None:
            return False
        self.db.delete(row)
        self.db.commit()
        return True

    def mark_credential_probe(self, credential_id: str, *, user_id: str) -> NativeAgentCredential | None:
        row = self.get_credential(credential_id, user_id=user_id)
        if row is None:
            return None
        # Phase 1 does not load an SDK client. Treat presence of encrypted key
        # and base_url as a local configuration probe.
        if row.base_url and row.api_key_enc:
            row.status = "ok"
            row.status_detail = "配置完整；SDK 运行将在后续阶段启用"
        else:
            row.status = "error"
            row.status_detail = "缺少 base URL 或 API key"
        row.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(row)
        return row

    # --- skills ----------------------------------------------------------

    def list_skills(self, *, user_id: str) -> list[Skill]:
        rows = (
            self.db.query(Skill)
            .filter(
                or_(
                    Skill.visibility == "public",
                    Skill.owner_user_id == user_id,
                    Skill.source == "project",
                )
            )
            .filter(Skill.source != "bundled")
            .order_by(Skill.visibility.asc(), Skill.updated_at.desc())
            .all()
        )
        hidden = self._hidden_skill_keys(user_id=user_id)
        return [
            row
            for row in rows
            if _skill_key(row) not in hidden and self._project_skill_is_active(row, user_id=user_id)
        ]

    def get_skill(self, skill_id: str, *, user_id: str) -> Skill | None:
        row = self.db.get(Skill, skill_id)
        if row is None:
            return None
        if row.source == "bundled":
            return None
        if _skill_key(row) in self._hidden_skill_keys(user_id=user_id):
            return None
        if not self._project_skill_is_active(row, user_id=user_id):
            return None
        if row.source == "project" or row.visibility == "public" or row.owner_user_id == user_id:
            return row
        return None

    def _project_skill_is_active(self, row: Skill, *, user_id: str) -> bool:
        if row.source != "project":
            return True
        if not row.project_id:
            return False
        project = self.db.get(Project, row.project_id)
        return (
            project is not None
            and project.is_skill_project
            and project.project_skill_id == row.id
            and ProjectMemberService(self.db).has_access(project.id, user_id)
        )

    def create_skill(
        self,
        *,
        user_id: str,
        name: str,
        folder_name: str = "",
        entry_filename: str = "SKILL.md",
        description: str,
        content: str,
        tags: list[str],
    ) -> Skill:
        if entry_filename != "SKILL.md":
            raise ValueError("只能上传精确命名的 SKILL.md")
        skill_name = _clean_name(folder_name or name or _skill_name_from_content(content))
        public_name = self._public_name(user_id=user_id, skill_name=skill_name)
        existing = (
            self.db.query(Skill)
            .filter(Skill.owner_user_id == user_id, Skill.public_name == public_name)
            .first()
        )
        if existing is not None:
            raise ValueError("Skill 已存在，请使用修改功能更新")
        row = Skill(
            owner_user_id=user_id,
            name=skill_name,
            public_name=public_name,
            description=description.strip(),
            content=encrypt_skill_content(content),
            visibility="private",
            source="upload",
            tags=_clean_tags(tags),
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row

    def create_recipe_skill(
        self,
        *,
        user_id: str,
        name: str,
        description: str,
        repo_url: str = "",
        source_url: str = "",
        source_ref: str = "",
        skill_name: str = "",
        install_command: str = "",
        tags: list[str] | None = None,
    ) -> Skill:
        parsed_source, parsed_skill = _parse_skill_add_command(install_command)
        source = (source_url or repo_url or parsed_source).strip()
        if not source:
            raise ValueError("自定义 Skill 需要 GitHub URL、npx 支持的 package，或完整 npx skills add 指令")
        cleaned_skill_name = (skill_name or parsed_skill).strip()
        if not is_direct_skill_source(source) and not cleaned_skill_name:
            raise ValueError("repo/package 安装需要填写 skill name；直接 GitHub Skill 文件夹 URL 可以留空")
        public_name = _recipe_public_name(
            user_id=user_id, source=source, skill_name=cleaned_skill_name, name=name
        )
        display_name = _clean_name(
            name or public_name or cleaned_skill_name or _skill_name_from_source(source)
        )
        command = build_npx_install_command(source, cleaned_skill_name)
        existing = (
            self.db.query(Skill)
            .filter(Skill.owner_user_id == user_id, Skill.public_name == public_name)
            .first()
        )
        if existing is not None:
            raise ValueError("Skill 已存在，请使用已有本地 Skill 装配 Agent")
        row = Skill(
            owner_user_id=user_id,
            name=display_name,
            public_name=public_name,
            description=description.strip(),
            content="",
            visibility="private",
            source="custom",
            tags=build_recipe_tags(
                source="custom",
                repo_url=(repo_url or parsed_source or source).strip(),
                source_url=source,
                source_ref=source_ref.strip(),
                skill_name=cleaned_skill_name,
                install_command=command,
                base_tags=_clean_tags(tags or []),
            ),
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row

    def update_project_skill_cache(self, project: Project, *, user_id: str) -> Skill:
        if not ProjectMemberService(self.db).can_write(project.id, user_id):
            raise ValueError("Project not found")

        root_skill = (
            self.db.query(Doc).filter_by(project_id=project.id, folder_id=None, name="SKILL.md").first()
        )
        if root_skill is None:
            raise ValueError("项目根目录需要包含 SKILL.md 才能缓存为 Skill")

        skill = self._project_skill_for(project, user_id=project.user_id)
        cache_root = _project_skill_cache_root(user_id=project.user_id, skill_id=skill.id)
        tmp = cache_root / f"current.tmp-{uuid4().hex}"
        current = cache_root / "current"
        if tmp.exists():
            shutil.rmtree(tmp)
        cache_root.mkdir(parents=True, exist_ok=True)

        try:
            doc_count, file_count, byte_count = ProjectFsService(self.db, project).materialize_to_directory(
                tmp
            )
            if not (tmp / "SKILL.md").is_file():
                raise ValueError("项目根目录需要包含 SKILL.md 才能缓存为 Skill")
            if current.exists():
                shutil.rmtree(current)
            tmp.rename(current)
        except Exception:
            if tmp.exists():
                shutil.rmtree(tmp)
            raise

        now = datetime.utcnow()
        previous_cache_version = int(skill.cache_version or 0)
        skill.cache_path = str(current)
        skill.cache_version = previous_cache_version + 1
        skill.cache_updated_at = now
        skill.version = (
            int(skill.version or 1) + 1 if previous_cache_version else max(int(skill.version or 1), 1)
        )
        skill.description = skill.description or f"Project-backed Skill cache for {project.name}"
        skill.tags = _project_skill_tags(
            project, doc_count=doc_count, file_count=file_count, byte_count=byte_count
        )
        skill.updated_at = now

        project.is_skill_project = True
        project.project_skill_id = skill.id
        project.skill_cache_version = skill.cache_version
        project.skill_cache_updated_at = now
        project.updated_at = now

        self.db.add(skill)
        self.db.add(project)
        self.db.commit()
        self.db.refresh(skill)
        self.db.refresh(project)
        return skill

    def _project_skill_for(self, project: Project, *, user_id: str) -> Skill:
        existing: Skill | None = None
        if project.project_skill_id:
            existing = self.db.get(Skill, project.project_skill_id)
            if (
                existing is not None
                and existing.owner_user_id == user_id
                and existing.source == "project"
                and existing.project_id == project.id
            ):
                return existing
        existing = (
            self.db.query(Skill)
            .filter(
                Skill.owner_user_id == user_id,
                Skill.source == "project",
                Skill.project_id == project.id,
            )
            .first()
        )
        if existing is not None:
            return existing

        name, public_name = self._unique_project_skill_names(user_id=user_id, base_name=project.name)
        skill = Skill(
            owner_user_id=user_id,
            name=name,
            public_name=public_name,
            description=f"Project-backed Skill cache for {project.name}",
            content="",
            visibility="private",
            source="project",
            project_id=project.id,
            version=1,
            cache_version=0,
            tags=["project-skill"],
        )
        self.db.add(skill)
        self.db.flush()
        return skill

    def _unique_project_skill_names(self, *, user_id: str, base_name: str) -> tuple[str, str]:
        author = self._github_login_optional(user_id=user_id) or "local"
        clean_base = _clean_project_skill_name(base_name or "Skill")
        for idx in range(100):
            suffix = "" if idx == 0 else f" ({idx})"
            name = f"{clean_base}{suffix}"
            public_name = f"{author}@{name}"
            exists = (
                self.db.query(Skill)
                .filter(Skill.owner_user_id == user_id, Skill.public_name == public_name)
                .first()
            )
            if exists is None:
                return name, public_name
        digest = hashlib.sha1(f"{user_id}:{base_name}".encode()).hexdigest()[:8]
        name = f"{clean_base}-{digest}"
        return name, f"{author}@{name}"

    def update_skill(
        self,
        skill_id: str,
        *,
        user_id: str,
        name: str | None = None,
        description: str | None = None,
        content: str | None = None,
        tags: list[str] | None = None,
    ) -> Skill | None:
        row = self.db.get(Skill, skill_id)
        if row is None or not self.can_edit_skill(row, user_id=user_id):
            return None
        if name is not None:
            row.name = _clean_name(name)
            row.public_name = self._public_name(user_id=user_id, skill_name=row.name)
        if description is not None:
            row.description = description.strip()
        if content is not None:
            row.content = encrypt_skill_content(content)
        if tags is not None:
            row.tags = _clean_tags(tags)
        row.version += 1
        row.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(row)
        return row

    def publish_skill(self, skill_id: str, *, user_id: str) -> Skill | None:
        row = self.db.get(Skill, skill_id)
        if row is None or not self.can_edit_skill(row, user_id=user_id):
            return None
        public_name = self._public_name(user_id=user_id, skill_name=row.name)
        existing = self.db.query(Skill).filter(Skill.public_name == public_name, Skill.id != skill_id).first()
        if existing is not None:
            raise ValueError("public skill name already exists")
        row.visibility = "public"
        row.public_name = public_name
        row.published_at = datetime.utcnow()
        row.updated_at = datetime.utcnow()
        self.db.add(row)
        self.db.flush()
        SkillReleaseCacheService(self.db).publish_skill(
            row,
            namespace=_skill_author(row) or self._github_login(user_id=user_id),
            slug=row.name,
            version=str(row.version or 1),
            visibility="public",
            publisher_user_id=user_id,
            install_spec=_release_install_spec_for_skill(row),
            source_type="user-skill",
            commit=False,
        )
        self.db.commit()
        self.db.refresh(row)
        return row

    def unpublish_skill(self, skill_id: str, *, user_id: str) -> Skill | None:
        row = self.db.get(Skill, skill_id)
        if row is None or not self.can_edit_skill(row, user_id=user_id):
            return None
        row.visibility = "private"
        row.published_at = None
        row.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(row)
        return row

    def delete_skill(self, skill_id: str, *, user_id: str) -> bool:
        row = self.get_skill(skill_id, user_id=user_id)
        if row is None:
            return False
        if row.owner_user_id == user_id and row.source != "bundled":
            if row.source == "project":
                self._clear_project_skill_link(row, user_id=user_id)
            self.db.delete(row)
        else:
            self._hide_skill(row, user_id=user_id)
        # Strip the now-unreachable id from every Agent's skill_ids list. Without
        # this, the orphan would resurface as `skill not available: <id>` the
        # next time someone PATCHed an Agent that used to reference it.
        self._cascade_strip_skill_ref(skill_id, user_id=user_id)
        self.db.commit()
        return True

    def _clear_project_skill_link(self, row: Skill, *, user_id: str) -> None:
        if not row.project_id:
            return
        project = self.db.get(Project, row.project_id)
        if project is not None and project.user_id == user_id and project.project_skill_id == row.id:
            project.project_skill_id = ""
            project.skill_cache_version = 0
            project.skill_cache_updated_at = None
            project.updated_at = datetime.utcnow()
            self.db.add(project)
        if row.cache_path:
            cache_root = Path(row.cache_path).parent
            if cache_root.exists():
                shutil.rmtree(cache_root, ignore_errors=True)

    def _cascade_strip_skill_ref(self, skill_id: str, *, user_id: str) -> None:
        """Remove a deleted skill's id from any Agent owned by this user that
        still references it. Hidden / public skills are scoped per user, so the
        cleanup is also scoped — we don't touch other users' agents.
        """
        agents = self.db.query(NativeAgent).filter(NativeAgent.owner_user_id == user_id).all()
        for agent in agents:
            ids = list(agent.skill_ids or [])
            if skill_id not in ids:
                continue
            agent.skill_ids = [s for s in ids if s != skill_id]
            self.db.add(agent)

    def agents_using_skill(self, skill_id: str, *, user_id: str) -> list[NativeAgent]:
        """Return Agents owned by this user whose skill_ids contains the id.
        Used by the API to populate `used_by_agent_count` and to label the
        delete-confirmation dialog with the impacted Agents.
        """
        agents = self.db.query(NativeAgent).filter(NativeAgent.owner_user_id == user_id).all()
        return [a for a in agents if skill_id in (a.skill_ids or [])]

    def can_edit_skill(self, row: Skill, *, user_id: str) -> bool:
        if row.source == "bundled" or row.owner_user_id != user_id:
            return False
        login = self._github_login_optional(user_id=user_id)
        if not login:
            return False
        author = _skill_author(row)
        return author.lower() == login.lower()

    def _hidden_skill_keys(self, *, user_id: str) -> set[str]:
        return {
            key
            for (key,) in self.db.query(SkillHidden.skill_key).filter(SkillHidden.user_id == user_id).all()
        }

    def _hide_skill(self, row: Skill, *, user_id: str) -> None:
        key = _skill_key(row)
        exists = (
            self.db.query(SkillHidden)
            .filter(SkillHidden.user_id == user_id, SkillHidden.skill_key == key)
            .first()
        )
        if exists is None:
            self.db.add(SkillHidden(user_id=user_id, skill_key=key))

    # --- project-scoped native agents -----------------------------------

    def list_agents(self, *, project_id: str, user_id: str) -> list[NativeAgent]:
        rows = (
            self.db.query(NativeAgent)
            .filter(NativeAgent.project_id == project_id, NativeAgent.owner_user_id == user_id)
            .order_by(NativeAgent.updated_at.desc())
            .all()
        )
        self._sync_agent_skill_refs(rows, project_id=project_id, user_id=user_id)
        return rows

    def list_agents_for_provider(
        self, *, project_id: str, user_id: str, provider_id: str
    ) -> list[NativeAgent]:
        rows = (
            self.db.query(NativeAgent)
            .filter(
                NativeAgent.project_id == project_id,
                NativeAgent.owner_user_id == user_id,
                NativeAgent.provider_id == provider_id,
            )
            .order_by(NativeAgent.updated_at.desc())
            .all()
        )
        self._sync_agent_skill_refs(rows, project_id=project_id, user_id=user_id)
        return rows

    def get_agent(self, agent_id: str, *, project_id: str, user_id: str) -> NativeAgent | None:
        row = self.db.get(NativeAgent, agent_id)
        if row is None or row.project_id != project_id or row.owner_user_id != user_id:
            return None
        self._sync_agent_skill_refs([row], project_id=project_id, user_id=user_id)
        return row

    def create_agent(
        self,
        *,
        project_id: str,
        user_id: str,
        name: str,
        description: str,
        provider_id: str,
        model: str,
        instructions: str,
        agent_md: str = "",
        skill_ids: list[str],
        skill_recipes: list[NativeAgentSkillRecipeIn] | list[dict] | None = None,
        output_contract: str,
        runtime_config: dict,
        is_enabled: bool,
    ) -> NativeAgent:
        self._validate_agent_refs(user_id=user_id, provider_id=provider_id, skill_ids=skill_ids)
        row = NativeAgent(
            project_id=project_id,
            owner_user_id=user_id,
            provider_id=provider_id,
            name=name.strip(),
            description=description.strip(),
            model=model.strip(),
            instructions=instructions,
            agent_md=(agent_md or instructions).strip(),
            skill_ids=skill_ids,
            output_contract=output_contract,
            runtime_config=runtime_config or {},
            is_enabled=is_enabled,
            setup_status="setting_up" if (skill_ids or skill_recipes) else "ready",
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        workspace = AgentWorkspaceService(self.db)
        workspace.ensure_workspace(row, agent_md=row.agent_md or row.instructions)
        self._install_selected_skills(row, user_id=user_id, project_id=project_id, skill_ids=skill_ids)
        self._install_skill_recipes(row, user_id=user_id, project_id=project_id, recipes=skill_recipes or [])
        self.db.commit()
        self.db.refresh(row)
        return row

    def update_agent(
        self,
        agent_id: str,
        *,
        project_id: str,
        user_id: str,
        patch: dict,
    ) -> NativeAgent | None:
        row = self.get_agent(agent_id, project_id=project_id, user_id=user_id)
        if row is None:
            return None
        provider_id = patch.get("provider_id", row.provider_id)
        skill_ids = patch.get("skill_ids", row.skill_ids)
        self._validate_agent_refs(
            user_id=user_id,
            provider_id=provider_id,
            skill_ids=skill_ids,
            existing_skill_ids=list(row.skill_ids or []),
        )

        for key in (
            "name",
            "description",
            "provider_id",
            "model",
            "instructions",
            "agent_md",
            "skill_ids",
            "output_contract",
            "runtime_config",
            "is_enabled",
        ):
            if key in patch and patch[key] is not None:
                setattr(row, key, patch[key])
        if "agent_md" in patch and patch["agent_md"] is not None:
            AgentWorkspaceService(self.db).write_agent_md(row, str(patch["agent_md"]))
        else:
            AgentWorkspaceService(self.db).ensure_workspace(row)
        if "skill_ids" in patch and patch["skill_ids"] is not None:
            self._install_selected_skills(
                row, user_id=user_id, project_id=project_id, skill_ids=row.skill_ids or []
            )
        if patch.get("skill_recipes"):
            self._install_skill_recipes(
                row, user_id=user_id, project_id=project_id, recipes=patch["skill_recipes"]
            )
        row.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(row)
        return row

    def delete_agent(self, agent_id: str, *, project_id: str, user_id: str) -> bool:
        row = self.get_agent(agent_id, project_id=project_id, user_id=user_id)
        if row is None:
            return False
        self._delete_agent_row(row)
        self.db.commit()
        return True

    def _delete_agent_row(self, row: NativeAgent) -> None:
        """Delete a NativeAgent and its dependent rows.

        NativeAgentSkillInstall has a non-cascading FK to native_agents, so
        without manual cleanup the agent delete fails on FK constraint
        (or leaves orphan installs). This helper centralizes the cleanup
        so both `delete_agent` and provider-cascade go through one path.
        Caller is responsible for committing.
        """
        (
            self.db.query(NativeAgentSkillInstall)
            .filter(NativeAgentSkillInstall.agent_id == row.id)
            .delete(synchronize_session=False)
        )
        self.db.delete(row)

    def delete_agents_for_provider(self, provider_id: str, *, user_id: str) -> int:
        """Delete every NativeAgent owned by `user_id` that points to
        `provider_id`. Returns the count. Used by ProviderService.delete to
        cascade clean up; caller commits.
        """
        agents = (
            self.db.query(NativeAgent)
            .filter(
                NativeAgent.provider_id == provider_id,
                NativeAgent.owner_user_id == user_id,
            )
            .all()
        )
        for agent in agents:
            self._delete_agent_row(agent)
        return len(agents)

    def list_agent_skill_installs(
        self, agent_id: str, *, project_id: str, user_id: str
    ) -> list[NativeAgentSkillInstall]:
        agent = self.get_agent(agent_id, project_id=project_id, user_id=user_id)
        if agent is None:
            return []
        return (
            self.db.query(NativeAgentSkillInstall)
            .filter(
                NativeAgentSkillInstall.agent_id == agent_id,
                NativeAgentSkillInstall.project_id == project_id,
                NativeAgentSkillInstall.user_id == user_id,
            )
            .order_by(NativeAgentSkillInstall.created_at.desc())
            .all()
        )

    def install_agent_skill_recipe(
        self,
        agent_id: str,
        *,
        project_id: str,
        user_id: str,
        recipe: NativeAgentSkillRecipeIn | dict,
    ) -> NativeAgentSkillInstall | None:
        agent = self.get_agent(agent_id, project_id=project_id, user_id=user_id)
        if agent is None:
            return None
        installs = self._install_skill_recipes(
            agent, user_id=user_id, project_id=project_id, recipes=[recipe]
        )
        self.db.commit()
        return installs[0] if installs else None

    def _sync_agent_skill_refs(self, agents: list[NativeAgent], *, project_id: str, user_id: str) -> None:
        if not agents:
            return
        changed = False
        for agent in agents:
            installs = (
                self.db.query(NativeAgentSkillInstall)
                .filter(
                    NativeAgentSkillInstall.agent_id == agent.id,
                    NativeAgentSkillInstall.project_id == project_id,
                    NativeAgentSkillInstall.user_id == user_id,
                    NativeAgentSkillInstall.status == "installed",
                )
                .all()
            )
            if not installs:
                continue
            current = [str(sid) for sid in agent.skill_ids or [] if str(sid)]
            next_ids = list(current)
            for install in installs:
                had_skill_id = bool(str(getattr(install, "skill_id", "") or "").strip())
                skill_id = self._skill_id_from_install(install, user_id=user_id)
                if not skill_id:
                    continue
                if self.get_skill(skill_id, user_id=user_id) is None:
                    continue
                if not had_skill_id:
                    changed = True
                if skill_id not in next_ids:
                    next_ids.append(skill_id)
                    changed = True
            if next_ids != current:
                agent.skill_ids = next_ids
                agent.updated_at = datetime.utcnow()
                self.db.add(agent)
                changed = True
        if changed:
            self.db.commit()

    def _local_skill_from_install(self, install: NativeAgentSkillInstall, *, user_id: str) -> Skill | None:
        source = str(install.source or "").strip() or "custom"
        if source not in {"marketplace", "custom"}:
            return None
        source_url = _source_from_install(install)
        if not source_url:
            return None
        skill_name = str(
            install.skill_name or install.folder_name or _skill_name_from_source(source_url)
        ).strip()
        public_name = (
            str(install.marketplace_id or "").strip()
            if source == "marketplace" and str(install.marketplace_id or "").strip()
            else _custom_public_name(user_id=user_id, name=skill_name, source=source_url)
        )
        existing = (
            self.db.query(Skill)
            .filter(Skill.owner_user_id == user_id, Skill.public_name == public_name)
            .first()
        )
        install_command = str(install.install_command or "").strip() or build_npx_install_command(
            source_url,
            skill_name,
        )
        tags = build_recipe_tags(
            source=source,
            repo_url=str(install.repo_url or source_url).strip(),
            source_url=source_url,
            source_ref=str(install.source_ref or "").strip(),
            skill_name=skill_name,
            install_command=install_command,
            marketplace_id=str(install.marketplace_id or "").strip(),
            base_tags=[],
        )
        if existing is not None:
            if not recipe_meta_from_tags(existing.tags).get("source_url"):
                existing.tags = tags
                existing.content = ""
                existing.source = source
                existing.updated_at = datetime.utcnow()
                self.db.add(existing)
            return existing
        row = Skill(
            owner_user_id=user_id,
            name=skill_name,
            public_name=public_name,
            description=f"Installed on Agent from {source_url}",
            content="",
            visibility="private",
            source=source,
            tags=tags,
        )
        self.db.add(row)
        self.db.flush()
        return row

    def _skill_id_from_install(self, install: NativeAgentSkillInstall, *, user_id: str) -> str:
        skill_id = str(getattr(install, "skill_id", "") or "").strip()
        if skill_id:
            return skill_id
        skill = self._legacy_local_skill_from_install(install, user_id=user_id)
        if skill is None:
            skill = self._local_skill_from_install(install, user_id=user_id)
        if skill is None:
            return ""
        install.skill_id = skill.id
        self.db.add(install)
        return skill.id

    def _legacy_local_skill_from_install(
        self,
        install: NativeAgentSkillInstall,
        *,
        user_id: str,
    ) -> Skill | None:
        folder_name = str(install.folder_name or "").strip()
        if folder_name:
            row = (
                self.db.query(Skill)
                .filter(Skill.owner_user_id == user_id, Skill.public_name == folder_name)
                .first()
            )
            if row is not None:
                return row
        skill_name = str(install.skill_name or "").strip()
        if not skill_name:
            return None
        skill = self._local_skill_from_install(install, user_id=user_id)
        if skill is not None:
            return skill
        return (
            self.db.query(Skill)
            .filter(Skill.owner_user_id == user_id, Skill.name == skill_name)
            .order_by(Skill.updated_at.desc())
            .first()
        )

    def _remove_unselected_skill_installs(
        self,
        agent: NativeAgent,
        *,
        user_id: str,
        project_id: str,
        selected_skill_ids: set[str],
    ) -> list[str]:
        rows = (
            self.db.query(NativeAgentSkillInstall)
            .filter(
                NativeAgentSkillInstall.agent_id == agent.id,
                NativeAgentSkillInstall.project_id == project_id,
                NativeAgentSkillInstall.user_id == user_id,
            )
            .all()
        )
        if not rows:
            return []

        workspace = AgentWorkspaceService(self.db)
        logs: list[str] = []
        for row in rows:
            skill_id = self._skill_id_from_install(row, user_id=user_id)
            if not skill_id:
                continue
            if skill_id in selected_skill_ids:
                continue

            label = row.skill_name or row.folder_name or skill_id
            if row.folder_name:
                try:
                    workspace.remove_skill_folder(agent, row.folder_name)
                except Exception as exc:
                    row.status = "remove_failed"
                    row.install_log = str(exc)[:12000]
                    self.db.add(row)
                    logs.append(f"{label}: remove failed: {row.install_log}")
                    continue
            self.db.delete(row)
            logs.append(f"{label}: removed")
        return logs

    def _installed_skill_ids_for_agent(
        self,
        agent: NativeAgent,
        *,
        project_id: str,
        user_id: str,
    ) -> set[str]:
        rows = (
            self.db.query(NativeAgentSkillInstall)
            .filter(
                NativeAgentSkillInstall.agent_id == agent.id,
                NativeAgentSkillInstall.project_id == project_id,
                NativeAgentSkillInstall.user_id == user_id,
                NativeAgentSkillInstall.status == "installed",
            )
            .all()
        )
        out: set[str] = set()
        for row in rows:
            skill_id = self._skill_id_from_install(row, user_id=user_id)
            if skill_id:
                out.add(skill_id)
        return out

    def _install_selected_skills(
        self,
        agent: NativeAgent,
        *,
        user_id: str,
        project_id: str,
        skill_ids: list[str],
    ) -> list[NativeAgentSkillInstall]:
        selected_skill_ids = _unique_ids(skill_ids)
        selected_skill_id_set = set(selected_skill_ids)
        removed_logs = self._remove_unselected_skill_installs(
            agent,
            user_id=user_id,
            project_id=project_id,
            selected_skill_ids=selected_skill_id_set,
        )

        if not selected_skill_ids:
            agent.setup_status = "ready"
            if removed_logs:
                agent.setup_log = "\n".join(removed_logs)[-12000:]
            self.db.add(agent)
            return []

        workspace = AgentWorkspaceService(self.db)
        workspace.ensure_workspace(agent)
        installer = SkillNpxInstaller(workspace)
        already_installed = self._installed_skill_ids_for_agent(
            agent,
            project_id=project_id,
            user_id=user_id,
        )
        pending_skill_ids = [skill_id for skill_id in selected_skill_ids if skill_id not in already_installed]
        if not pending_skill_ids:
            agent.setup_status = "ready"
            if removed_logs:
                agent.setup_log = "\n".join(removed_logs)[-12000:]
            self.db.add(agent)
            return []

        installed_rows: list[NativeAgentSkillInstall] = []
        logs: list[str] = list(removed_logs)
        agent.setup_status = "setting_up"
        self.db.add(agent)
        self.db.flush()

        for skill_id in pending_skill_ids:
            skill = self.get_skill(str(skill_id), user_id=user_id)
            if skill is None:
                continue
            recipe = _recipe_from_skill(skill)
            if recipe is not None:
                row = NativeAgentSkillInstall(
                    project_id=project_id,
                    user_id=user_id,
                    agent_id=agent.id,
                    skill_id=skill.id,
                    source=recipe.source or skill.source,
                    marketplace_id=recipe.marketplace_id,
                    repo_url=recipe.repo_url,
                    source_ref=recipe.source_ref,
                    skill_name=recipe.skill_name or skill.name,
                    install_command=recipe.install_command,
                    status="running",
                )
                self.db.add(row)
                self.db.flush()
                try:
                    result = installer.install(agent, recipe)
                except SkillNpxInstallError as exc:
                    row.status = "failed"
                    row.install_log = str(exc)[:12000]
                    logs.append(f"{skill.public_name or skill.name}: {row.install_log}")
                    installed_rows.append(row)
                    continue
                row.status = "installed"
                row.folder_name = result.folder_name
                row.folder_path = result.folder_path
                row.manifest = result.manifest
                row.install_command = result.install_command
                row.install_log = result.log
                row.installed_at = datetime.utcnow()
                logs.append(f"{skill.public_name or skill.name}: installed as {result.folder_name}")
                installed_rows.append(row)
                continue

            if skill.source == "project":
                cache_path = Path(skill.cache_path) if skill.cache_path else None
                row = NativeAgentSkillInstall(
                    project_id=project_id,
                    user_id=user_id,
                    agent_id=agent.id,
                    skill_id=skill.id,
                    source=skill.source,
                    marketplace_id="",
                    repo_url="",
                    source_ref="",
                    skill_name=skill.name,
                    install_command="project Skill cache reference",
                    status="running",
                )
                self.db.add(row)
                self.db.flush()
                if cache_path is None or not cache_path.exists() or not (cache_path / "SKILL.md").is_file():
                    row.status = "failed"
                    row.install_log = (
                        "Project Skill cache is missing; update Skill cache from the project first"
                    )
                    logs.append(f"{skill.public_name or skill.name}: {row.install_log}")
                    installed_rows.append(row)
                    continue
                try:
                    manifest = workspace.build_manifest(cache_path)
                    ref = workspace.install_skill_reference(
                        agent,
                        folder_name=skill.public_name or skill.name,
                        target_path=cache_path,
                        manifest=manifest,
                    )
                except (AgentWorkspaceError, OSError) as exc:
                    row.status = "failed"
                    row.install_log = str(exc)[:12000]
                    logs.append(f"{skill.public_name or skill.name}: {row.install_log}")
                    installed_rows.append(row)
                    continue
                row.status = "installed"
                row.folder_name = skill.public_name or skill.name
                row.folder_path = str(ref)
                row.manifest = manifest
                row.install_log = f"Using project Skill cache at {cache_path}"
                row.installed_at = datetime.utcnow()
                logs.append(f"{skill.public_name or skill.name}: using project Skill cache")
                installed_rows.append(row)
                continue

            content = decrypt_skill_content(skill.content)
            row = NativeAgentSkillInstall(
                project_id=project_id,
                user_id=user_id,
                agent_id=agent.id,
                skill_id=skill.id,
                source=skill.source,
                marketplace_id="",
                repo_url="",
                source_ref="",
                skill_name=skill.name,
                install_command="local SKILL.md copy",
                status="running",
            )
            self.db.add(row)
            self.db.flush()
            if not content.strip():
                row.status = "failed"
                row.install_log = "Local Skill has no SKILL.md content or npx recipe"
                logs.append(f"{skill.public_name or skill.name}: {row.install_log}")
                installed_rows.append(row)
                continue
            try:
                dest, manifest = workspace.install_skill_content(
                    agent,
                    folder_name=skill.public_name or skill.name,
                    content=content,
                )
            except Exception as exc:
                row.status = "failed"
                row.install_log = str(exc)[:12000]
                logs.append(f"{skill.public_name or skill.name}: {row.install_log}")
                installed_rows.append(row)
                continue
            row.status = "installed"
            row.folder_name = dest.name
            row.folder_path = str(dest)
            row.manifest = manifest
            row.install_log = "Installed local SKILL.md."
            row.installed_at = datetime.utcnow()
            logs.append(f"{skill.public_name or skill.name}: installed as {dest.name}")
            installed_rows.append(row)

        if installed_rows and all(row.status == "installed" for row in installed_rows):
            agent.setup_status = "ready"
        elif installed_rows:
            agent.setup_status = "setup_failed"
        else:
            agent.setup_status = "ready"
        agent.setup_log = "\n".join(logs)[-12000:]
        self.db.add(agent)
        return installed_rows

    def _validate_agent_refs(
        self,
        *,
        user_id: str,
        provider_id: str,
        skill_ids: list[str],
        existing_skill_ids: list[str] | None = None,
    ) -> None:
        provider = self.db.get(Provider, provider_id) if provider_id else None
        if provider is None or provider.user_id != user_id:
            raise ValueError("provider not found")
        if provider.kind != "native":
            raise ValueError("provider is not native")
        # When updating, only newly-added skill ids need to be reachable. An
        # already-bound skill that has since become unreachable (deleted from
        # the marketplace, hidden, ownership changed) shouldn't block an
        # unrelated PATCH — the user can scrub it later by editing skill_ids.
        existing = set(str(s) for s in (existing_skill_ids or []))
        for sid in skill_ids:
            if str(sid) in existing:
                continue
            if self.get_skill(str(sid), user_id=user_id) is None:
                raise ValueError(f"skill not available: {sid}")

    def _install_skill_recipes(
        self,
        agent: NativeAgent,
        *,
        user_id: str,
        project_id: str,
        recipes: list[NativeAgentSkillRecipeIn] | list[dict],
    ) -> list[NativeAgentSkillInstall]:
        if not recipes:
            if not agent.setup_status:
                agent.setup_status = "ready"
            return []

        workspace = AgentWorkspaceService(self.db)
        workspace.ensure_workspace(agent)
        installer = SkillNpxInstaller(workspace)
        installed_rows: list[NativeAgentSkillInstall] = []
        logs: list[str] = []
        agent.setup_status = "setting_up"
        self.db.add(agent)
        self.db.flush()

        for raw in recipes:
            recipe = _recipe_from(raw)
            row = NativeAgentSkillInstall(
                project_id=project_id,
                user_id=user_id,
                agent_id=agent.id,
                source=recipe.source or "marketplace",
                marketplace_id=recipe.marketplace_id,
                repo_url=recipe.repo_url,
                source_ref=recipe.source_ref,
                skill_name=recipe.skill_name,
                install_command=recipe.install_command,
                status="running",
            )
            self.db.add(row)
            self.db.flush()
            try:
                result = installer.install(agent, recipe)
            except SkillNpxInstallError as exc:
                row.status = "failed"
                row.install_log = str(exc)[:12000]
                agent.setup_status = "setup_failed"
                logs.append(f"{recipe.skill_name}: {row.install_log}")
                installed_rows.append(row)
                continue
            row.status = "installed"
            row.folder_name = result.folder_name
            row.folder_path = result.folder_path
            row.manifest = result.manifest
            row.install_command = result.install_command
            row.install_log = result.log
            row.installed_at = datetime.utcnow()
            installed_rows.append(row)
            logs.append(f"{recipe.skill_name}: installed as {result.folder_name}")

        if all(row.status == "installed" for row in installed_rows):
            agent.setup_status = "ready"
        else:
            agent.setup_status = "setup_failed"
        agent.setup_log = "\n".join(logs)[-12000:]
        self.db.add(agent)
        return installed_rows

    def _public_name(self, *, user_id: str, skill_name: str) -> str:
        username = self._github_login(user_id=user_id)
        return f"{username}@{_slug(skill_name)}"

    def _github_login(self, *, user_id: str) -> str:
        login = self._github_login_optional(user_id=user_id)
        if not login:
            raise ValueError("请先连接 GitHub 账号，再上传私有 Skill")
        return login

    def _github_login_optional(self, *, user_id: str) -> str:
        account = self.db.query(GitHubAccount).filter(GitHubAccount.user_id == user_id).first()
        login = str(getattr(account, "login", "") if account is not None else "").strip()
        if not login or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", login):
            return ""
        return login

    def _ensure_system_skills(self) -> None:
        existing = {
            name
            for (name,) in self.db.query(Skill.name)
            .filter(Skill.source == "bundled", Skill.visibility == "system")
            .all()
        }
        missing = [item for item in SYSTEM_SKILLS if item["name"] not in existing]
        if not missing:
            return
        now = datetime.utcnow()
        for item in missing:
            self.db.add(
                Skill(
                    owner_user_id="system",
                    name=item["name"],
                    public_name=item["name"],
                    description=item["description"],
                    content=encrypt_skill_content(item["content"]),
                    visibility="system",
                    source="bundled",
                    version=1,
                    tags=item["tags"],
                    created_at=now,
                    updated_at=now,
                    published_at=now,
                )
            )
        self.db.commit()


def _clean_name(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("name required")
    return cleaned


def _clean_project_skill_name(value: str) -> str:
    cleaned = re.sub(r"[\x00-\x1f/\\:]+", "-", str(value or "").strip()).strip(" .")
    return cleaned[:100] or "Skill"


def _project_skill_cache_root(*, user_id: str, skill_id: str) -> Path:
    return settings.data_dir / "skills-cache" / "users" / _slug(user_id) / _slug(skill_id)


def _project_skill_tags(project: Project, *, doc_count: int, file_count: int, byte_count: int) -> list[str]:
    return _clean_tags(
        [
            "project-skill",
            f"ylw:project-id={project.id}",
            f"ylw:project-docs={doc_count}",
            f"ylw:project-files={file_count}",
            f"ylw:project-bytes={byte_count}",
        ]
    )


def _unique_ids(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        cleaned = str(value or "").strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            out.append(cleaned)
    return out


def _skill_name_from_content(content: str) -> str:
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
        if stripped.lower().startswith("name:"):
            return stripped.split(":", 1)[1].strip()
    return "SKILL"


def _skill_name_from_source(source: str) -> str:
    cleaned = str(source or "").rstrip("/")
    if not cleaned:
        return "custom-skill"
    tail = cleaned.split("/")[-1].removesuffix(".git")
    return tail or "custom-skill"


def _custom_public_name(*, user_id: str, name: str, source: str) -> str:
    digest = hashlib.sha1(f"{user_id}:{source}".encode()).hexdigest()[:10]
    return f"custom@{_slug(name)}-{digest}"


def _recipe_public_name(*, user_id: str, source: str, skill_name: str, name: str = "") -> str:
    github_name = _github_recipe_public_name(source, skill_name)
    if github_name:
        return github_name
    display = name or skill_name or _skill_name_from_source(source)
    return _custom_public_name(user_id=user_id, name=display, source=source)


def _github_recipe_public_name(source: str, skill_name: str) -> str:
    match = re.match(r"^git@github\.com:([^/]+)/(.+?)(?:\.git)?$", str(source or "").strip())
    if match:
        owner = match.group(1)
        return f"{owner}@{_slug(skill_name)}" if skill_name else ""
    parsed = re.match(r"^https://github\.com/([^/]+)/(.+)$", str(source or "").strip())
    if not parsed:
        return ""
    owner = parsed.group(1)
    tail = parsed.group(2).rstrip("/").split("/")[-1].removesuffix(".git")
    if "@" in tail:
        return tail
    if skill_name:
        return f"{owner}@{_slug(skill_name)}"
    return ""


def _skill_author(row: Skill) -> str:
    if row.source == "marketplace":
        for tag in row.tags or []:
            text = str(tag)
            if text.startswith("ylw:catalog-author="):
                return text.split("=", 1)[1].strip()
    public_name = str(row.public_name or "")
    if "@" in public_name:
        return public_name.split("@", 1)[0].strip()
    return ""


def _skill_key(row: Skill) -> str:
    return str(row.public_name or row.id or row.name)


def _clean_tags(tags: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for tag in tags or []:
        cleaned = str(tag).strip().lstrip("#").strip()
        key = cleaned.lower()
        if cleaned and key not in seen:
            seen.add(key)
            out.append(cleaned[:48])
    return out[:20]


def _slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip()).strip("-").lower()
    return cleaned or "user"


def _recipe_from_skill(row: Skill) -> SkillInstallRecipe | None:
    meta = recipe_meta_from_tags(row.tags)
    source_url = (meta.get("source_url") or meta.get("repo_url") or "").strip()
    if not source_url:
        return None
    skill_name = (meta.get("skill_name") or row.name or "").strip()
    install_command = (
        meta.get("install_command") or build_npx_install_command(source_url, skill_name)
    ).strip()
    return SkillInstallRecipe(
        repo_url=(meta.get("repo_url") or source_url).strip(),
        source_url=source_url,
        source_ref=meta.get("source_ref", "").strip(),
        skill_name=skill_name,
        install_command=install_command,
        marketplace_id=meta.get("marketplace_id", "").strip()
        or (row.public_name if row.source == "marketplace" else ""),
        source=meta.get("source", "").strip() or row.source or "custom",
    )


def _release_install_spec_for_skill(row: Skill) -> str:
    meta = recipe_meta_from_tags(row.tags)
    payload = {
        "source": row.source or "user-skill",
        "skill_id": row.id,
        "public_name": row.public_name,
        "name": row.name,
        "version": str(row.version or 1),
    }
    for key in (
        "repo_url",
        "source_url",
        "source_ref",
        "skill_name",
        "install_command",
        "marketplace_id",
    ):
        value = str(meta.get(key) or "").strip()
        if value:
            payload[key] = value
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _source_from_install(row: NativeAgentSkillInstall) -> str:
    command_source = _source_from_install_command(row.install_command)
    return command_source or str(row.repo_url or "").strip()


def _source_from_install_command(command: str) -> str:
    text = str(command or "").strip()
    if not text:
        return ""
    try:
        parts = shlex.split(text)
    except ValueError:
        return ""
    for idx in range(len(parts) - 3):
        if parts[idx] == "npx" and parts[idx + 2] == "skills" and parts[idx + 3] == "add":
            return parts[idx + 4] if idx + 4 < len(parts) else ""
        if parts[idx] == "skills" and parts[idx + 1] == "add":
            return parts[idx + 2] if idx + 2 < len(parts) else ""
    return ""


def _parse_skill_add_command(command: str) -> tuple[str, str]:
    text = str(command or "").strip()
    if not text:
        return "", ""
    try:
        parts = shlex.split(text)
    except ValueError:
        return "", ""
    source = ""
    skill_name = ""
    for idx in range(len(parts) - 1):
        if parts[idx] != "skills" or parts[idx + 1] != "add":
            continue
        if idx + 2 >= len(parts):
            break
        source = parts[idx + 2]
        rest = parts[idx + 3 :]
        for opt_idx, item in enumerate(rest):
            if item == "--skill" and opt_idx + 1 < len(rest):
                skill_name = rest[opt_idx + 1]
                break
            if item.startswith("--skill="):
                skill_name = item.split("=", 1)[1]
                break
        break
    return source, skill_name


def _recipe_from(raw: NativeAgentSkillRecipeIn | dict) -> SkillInstallRecipe:
    if isinstance(raw, NativeAgentSkillRecipeIn):
        data = raw.model_dump()
    elif hasattr(raw, "model_dump"):
        data = raw.model_dump()
    else:
        data = dict(raw or {})
    return SkillInstallRecipe(
        repo_url=str(data.get("repo_url") or "").strip(),
        skill_name=str(data.get("skill_name") or "").strip(),
        source_url=str(data.get("source_url") or "").strip(),
        install_command=str(data.get("install_command") or "").strip(),
        marketplace_id=str(data.get("marketplace_id") or "").strip(),
        source_ref=str(data.get("source_ref") or "").strip(),
        source=str(data.get("source") or "marketplace").strip() or "marketplace",
    )

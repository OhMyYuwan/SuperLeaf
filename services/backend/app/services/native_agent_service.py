"""Native Agent registry service.

Phase 1 only: CRUD/configuration for backend-run native Agents, encrypted
credentials, and Skills. Runtime execution is intentionally out of scope.
"""

from __future__ import annotations

from datetime import datetime
import re

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models import GitHubAccount, NativeAgent, NativeAgentCredential, Provider, Skill, SkillHidden
from ..secrets_vault import encrypt
from .skill_content_crypto import encrypt_skill_content


SYSTEM_SKILLS = [
    {
        "name": "annotation-review",
        "description": "读取传入的批注上下文，给出聚焦、可执行的修改建议。",
        "content": "你是项目批注审阅助手。只能基于调用方传入的批注、引用片段和讨论内容工作，不直接读取或修改项目文件。输出应简洁、可执行，并明确指出需要用户确认的部分。",
        "tags": ["annotation", "review"],
    },
    {
        "name": "plan-breakdown",
        "description": "把项目需求拆解为可执行计划、风险点和验收标准。",
        "content": "你是项目计划助手。只能使用调用方传入的需求、项目元信息和显式上下文。输出计划时包含阶段、依赖、风险和验收标准，避免假设未传入的文件内容。",
        "tags": ["planning", "project"],
    },
    {
        "name": "workflow-draft",
        "description": "根据传入目标生成工作流草稿和节点说明。",
        "content": "你是工作流草稿助手。根据调用方提供的目标、输入输出约束和可用节点，生成清晰的工作流草案。不得直接访问项目文件，必须要求调用方提供必要上下文。",
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
                )
            )
            .filter(Skill.source != "bundled")
            .order_by(Skill.visibility.asc(), Skill.updated_at.desc())
            .all()
        )
        hidden = self._hidden_skill_keys(user_id=user_id)
        return [row for row in rows if _skill_key(row) not in hidden]

    def get_skill(self, skill_id: str, *, user_id: str) -> Skill | None:
        row = self.db.get(Skill, skill_id)
        if row is None:
            return None
        if row.source == "bundled":
            return None
        if _skill_key(row) in self._hidden_skill_keys(user_id=user_id):
            return None
        if row.visibility == "public" or row.owner_user_id == user_id:
            return row
        return None

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
        existing = (
            self.db.query(Skill)
            .filter(Skill.public_name == public_name, Skill.id != skill_id)
            .first()
        )
        if existing is not None:
            raise ValueError("public skill name already exists")
        row.visibility = "public"
        row.public_name = public_name
        row.published_at = datetime.utcnow()
        row.updated_at = datetime.utcnow()
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
        row = self.db.get(Skill, skill_id)
        if row is None:
            return False
        if row.owner_user_id == user_id and row.source != "bundled":
            self.db.delete(row)
        else:
            self._hide_skill(row, user_id=user_id)
        self.db.commit()
        return True

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
            for (key,) in self.db.query(SkillHidden.skill_key)
            .filter(SkillHidden.user_id == user_id)
            .all()
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
        return (
            self.db.query(NativeAgent)
            .filter(NativeAgent.project_id == project_id, NativeAgent.owner_user_id == user_id)
            .order_by(NativeAgent.updated_at.desc())
            .all()
        )

    def list_agents_for_provider(self, *, project_id: str, user_id: str, provider_id: str) -> list[NativeAgent]:
        return (
            self.db.query(NativeAgent)
            .filter(
                NativeAgent.project_id == project_id,
                NativeAgent.owner_user_id == user_id,
                NativeAgent.provider_id == provider_id,
            )
            .order_by(NativeAgent.updated_at.desc())
            .all()
        )

    def get_agent(self, agent_id: str, *, project_id: str, user_id: str) -> NativeAgent | None:
        row = self.db.get(NativeAgent, agent_id)
        if row is None or row.project_id != project_id or row.owner_user_id != user_id:
            return None
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
        skill_ids: list[str],
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
            skill_ids=skill_ids,
            output_contract=output_contract,
            runtime_config=runtime_config or {},
            is_enabled=is_enabled,
        )
        self.db.add(row)
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
        self._validate_agent_refs(user_id=user_id, provider_id=provider_id, skill_ids=skill_ids)

        for key in ("name", "description", "provider_id", "model", "instructions", "skill_ids", "output_contract", "runtime_config", "is_enabled"):
            if key in patch and patch[key] is not None:
                setattr(row, key, patch[key])
        row.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(row)
        return row

    def delete_agent(self, agent_id: str, *, project_id: str, user_id: str) -> bool:
        row = self.get_agent(agent_id, project_id=project_id, user_id=user_id)
        if row is None:
            return False
        self.db.delete(row)
        self.db.commit()
        return True

    def _validate_agent_refs(self, *, user_id: str, provider_id: str, skill_ids: list[str]) -> None:
        provider = self.db.get(Provider, provider_id) if provider_id else None
        if provider is None or provider.user_id != user_id:
            raise ValueError("provider not found")
        if provider.kind != "native":
            raise ValueError("provider is not native")
        for sid in skill_ids:
            if self.get_skill(str(sid), user_id=user_id) is None:
                raise ValueError(f"skill not available: {sid}")

    def _public_name(self, *, user_id: str, skill_name: str) -> str:
        username = self._github_login(user_id=user_id)
        return f"{username}@{_slug(skill_name)}"

    def _github_login(self, *, user_id: str) -> str:
        login = self._github_login_optional(user_id=user_id)
        if not login:
            raise ValueError("请先连接 GitHub 账号，再上传私有 Skill")
        return login

    def _github_login_optional(self, *, user_id: str) -> str:
        account = (
            self.db.query(GitHubAccount)
            .filter(GitHubAccount.user_id == user_id)
            .first()
        )
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


def _skill_name_from_content(content: str) -> str:
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
        if stripped.lower().startswith("name:"):
            return stripped.split(":", 1)[1].strip()
    return "SKILL"


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

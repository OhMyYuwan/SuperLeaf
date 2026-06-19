"""Workflow Template Service — instantiates pre-defined workflow graphs.

Creates WorkflowDefinition + installs template Skills into the user's Skill library.
Does NOT create NativeAgents — inline agent nodes carry their own config.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..models import Project, Skill, SkillRelease, WorkflowDefinition, WorkflowTemplate
from .skill_content_crypto import decrypt_skill_content, encrypt_skill_content
from .skill_marketplace_service import SkillMarketplaceError, SkillMarketplaceService

REPO_ROOT = Path(__file__).resolve().parents[4]
BUILTIN_TEMPLATE_ROOT = Path(__file__).resolve().parents[1] / "workflow_templates"


@dataclass
class TemplateInstantiationResult:
    workflow_definition_id: str = ""
    workflow_name: str = ""
    installed_skills: list[str] | None = None
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "workflow_definition_id": self.workflow_definition_id,
            "workflow_name": self.workflow_name,
            "installed_skills": self.installed_skills or [],
            "error": self.error,
        }


@dataclass
class TemplatePrepareResult:
    installed_skills: list[str] | None = None
    graph_template: dict | None = None
    template_name: str = ""
    template_description: str = ""
    error: str = ""


@dataclass
class InstalledTemplateSkill:
    row: Skill
    release: SkillRelease | None = None
    marketplace_id: str = ""
    install_command: str = ""


class WorkflowTemplateService:
    """Instantiate workflow templates into projects."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def instantiate(
        self,
        template_id: str,
        *,
        project_id: str,
        user_id: str,
        name: str = "",
    ) -> TemplateInstantiationResult:
        """Instantiate a workflow template into a project.

        1. Install required Skills into the user's Skill library
        2. Create WorkflowDefinition with inline agent nodes
        """
        # Load template
        template = (
            self.db.query(WorkflowTemplate)
            .filter(WorkflowTemplate.id == template_id)
            .first()
        )
        if template is None:
            return TemplateInstantiationResult(error="Template not found")

        project = self.db.query(Project).filter(Project.id == project_id).first()
        if project is None:
            return TemplateInstantiationResult(error="Project not found")

        try:
            skills_by_name = self._install_skills(
                project,
                template.required_skills or [],
                user_id=user_id,
                template_id=template.id,
            )
        except SkillMarketplaceError as exc:
            return TemplateInstantiationResult(error=str(exc))
        graph = _graph_with_inline_skill_refs(template.graph_template or {}, skills_by_name)

        # Create WorkflowDefinition
        wf_name = name or f"{template.name} (from template)"

        wf_def = WorkflowDefinition(
            project_id=project_id,
            user_id=user_id,
            name=wf_name,
            description=f"Auto-created from template: {template.name}",
            execution_mode="graph",
            graph=graph,
            config={"max_rounds": 3},
        )
        self.db.add(wf_def)
        self.db.commit()
        self.db.refresh(wf_def)

        return TemplateInstantiationResult(
            workflow_definition_id=wf_def.id,
            workflow_name=wf_name,
            installed_skills=list(skills_by_name.keys()),
        )

    def prepare(
        self,
        template_id: str,
        *,
        project_id: str,
        user_id: str,
    ) -> TemplatePrepareResult:
        """Prepare a template: install Skills and return the graph template.

        Does NOT create a WorkflowDefinition.
        """
        template = (
            self.db.query(WorkflowTemplate)
            .filter(WorkflowTemplate.id == template_id)
            .first()
        )
        if template is None:
            return TemplatePrepareResult(error="Template not found")

        project = self.db.query(Project).filter(Project.id == project_id).first()
        if project is None:
            return TemplatePrepareResult(error="Project not found")

        try:
            skills_by_name = self._install_skills(
                project,
                template.required_skills or [],
                user_id=user_id,
                template_id=template.id,
            )
        except SkillMarketplaceError as exc:
            return TemplatePrepareResult(error=str(exc))
        graph = _graph_with_inline_skill_refs(template.graph_template or {}, skills_by_name)

        return TemplatePrepareResult(
            installed_skills=list(skills_by_name.keys()),
            graph_template=graph,
            template_name=template.name,
            template_description=template.description,
        )

    def list_templates(self, category: str | None = None) -> list[dict]:
        """List available templates."""
        q = self.db.query(WorkflowTemplate)
        if category:
            q = q.filter(WorkflowTemplate.category == category)
        templates = q.order_by(WorkflowTemplate.created_at.desc()).all()
        return [
            {
                "id": t.id,
                "name": t.name,
                "description": t.description,
                "category": t.category,
                "required_skills": [s.get("name", "") for s in (t.required_skills or [])],
            }
            for t in templates
        ]

    def _install_skills(
        self,
        project: Project,
        required_skills: list[dict],
        *,
        user_id: str,
        template_id: str,
    ) -> dict[str, InstalledTemplateSkill]:
        """Install required template Skills into the user's local Skill library."""
        installed: dict[str, InstalledTemplateSkill] = {}

        for skill_def in required_skills:
            skill_name = skill_def.get("name", "")
            if not skill_name:
                continue

            marketplace_id = str(skill_def.get("marketplace_id") or "").strip()
            if marketplace_id:
                row, entry = SkillMarketplaceService(self.db).install(
                    marketplace_id,
                    user_id=user_id,
                )
                release = self._latest_release_for_skill(row.id)
                spec = _install_metadata_from_spec(release.install_spec if release else "")
                installed[skill_name] = InstalledTemplateSkill(
                    row=row,
                    release=release,
                    marketplace_id=(
                        str(getattr(entry, "id", "") or "").strip()
                        or spec.get("marketplace_id", "")
                        or marketplace_id
                    ),
                    install_command=(
                        str(getattr(entry, "install_command", "") or "").strip()
                        or spec.get("install_command", "")
                        or str(skill_def.get("install_command") or "").strip()
                    ),
                )
                continue

            skill_content = _resolve_skill_content(skill_def)
            if not skill_content:
                continue
            public_name = f"workflow-template:{template_id}:{skill_name}"
            row = (
                self.db.query(Skill)
                .filter(
                    Skill.owner_user_id == user_id,
                    Skill.source == "template",
                    Skill.public_name == public_name,
                )
                .first()
            )
            if row is None:
                row = Skill(
                    owner_user_id=user_id,
                    name=skill_name,
                    public_name=public_name,
                    description=str(skill_def.get("description") or ""),
                    content=encrypt_skill_content(skill_content),
                    visibility="private",
                    source="template",
                    project_id=project.id,
                    version=1,
                    tags=["workflow-template", f"template:{template_id}"],
                )
                self.db.add(row)
                self.db.flush()
            else:
                current = decrypt_skill_content(row.content)
                row.name = skill_name
                row.description = str(skill_def.get("description") or row.description or "")
                row.project_id = project.id
                row.visibility = "private"
                row.tags = ["workflow-template", f"template:{template_id}"]
                if current != skill_content:
                    row.content = encrypt_skill_content(skill_content)
                    row.version = int(row.version or 1) + 1
                self.db.add(row)
                self.db.flush()
            installed[skill_name] = InstalledTemplateSkill(row=row)

        self.db.commit()
        return installed

    def _latest_release_for_skill(self, skill_id: str) -> SkillRelease | None:
        return (
            self.db.query(SkillRelease)
            .filter(SkillRelease.source_skill_id == skill_id)
            .order_by(SkillRelease.created_at.desc())
            .first()
        )


def _resolve_skill_content(skill_def: dict) -> str:
    raw = str(skill_def.get("content") or "")
    if raw.startswith("file:"):
        path = Path(raw.removeprefix("file:")).expanduser()
        if not path.is_absolute():
            path = REPO_ROOT / path
        if path.is_file():
            return path.read_text(encoding="utf-8")
        return ""
    return raw


def _install_metadata_from_spec(raw: str) -> dict[str, str]:
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        "marketplace_id": str(data.get("marketplace_id") or "").strip(),
        "install_command": str(data.get("install_command") or "").strip(),
    }


def _graph_with_inline_skill_refs(
    graph: dict,
    skills_by_name: dict[str, InstalledTemplateSkill],
) -> dict:
    next_graph = copy.deepcopy(graph or {})
    nodes = next_graph.get("nodes")
    if not isinstance(nodes, list):
        return next_graph

    for node in nodes:
        if not isinstance(node, dict):
            continue
        config = node.get("config")
        if not isinstance(config, dict):
            continue
        placeholders = _skill_ref_placeholders(config.get("skills"))
        placeholders.extend(
            {"alias": name, "display_name": name}
            for name in _string_list(config.get("skill_names"))
        )
        if not placeholders:
            continue

        refs = []
        for placeholder in placeholders:
            installed = _installed_skill_for_ref(placeholder, skills_by_name)
            if installed is None:
                refs.append(placeholder)
                continue
            skill = installed.row
            ref = {
                **placeholder,
                "alias": str(
                    placeholder.get("alias")
                    or placeholder.get("display_name")
                    or skill.name
                ).strip(),
                "display_name": skill.name,
                "source": skill.source or "template",
            }
            if installed.release is not None:
                ref.pop("skill_id", None)
                ref.update(
                    {
                        "source_skill_id": skill.id,
                        "release_id": installed.release.id,
                        "version": installed.release.version,
                        "checksum": installed.release.artifact_checksum,
                    }
                )
            else:
                ref["skill_id"] = skill.id
            if installed.marketplace_id:
                ref["marketplace_id"] = installed.marketplace_id
            if installed.install_command:
                ref["install_command"] = installed.install_command
            refs.append(ref)
        if not refs:
            continue

        config["agent_source"] = "inline"
        config["inline_agent"] = True
        config["skills"] = refs
        config.pop("skill_names", None)
        config.setdefault("provider", {})
    return next_graph


def _skill_ref_placeholders(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    refs = []
    for item in value:
        if isinstance(item, dict):
            refs.append(copy.deepcopy(item))
    return refs


def _installed_skill_for_ref(
    ref: dict[str, Any],
    skills_by_name: dict[str, InstalledTemplateSkill],
) -> InstalledTemplateSkill | None:
    for candidate in _skill_ref_candidates(ref):
        installed = skills_by_name.get(candidate)
        if installed is not None:
            return installed
    return None


def _skill_ref_candidates(ref: dict[str, Any]) -> list[str]:
    values = [
        ref.get("alias"),
        ref.get("name"),
        ref.get("display_name"),
        ref.get("slug"),
        ref.get("skill_name"),
    ]
    marketplace_id = str(ref.get("marketplace_id") or "").strip()
    if marketplace_id:
        values.append(marketplace_id)
        if "@" in marketplace_id:
            values.append(marketplace_id.split("@", 1)[1])
    candidates = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in candidates:
            candidates.append(text)
    return candidates


def _string_list(value: Any) -> list[str]:
    if isinstance(value, str):
        stripped = value.strip()
        return [stripped] if stripped else []
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


# ---------------------------------------------------------------------------
# Built-in template: skill-optimization-v1
# ---------------------------------------------------------------------------


def _load_builtin_template_payload(filename: str) -> dict[str, Any]:
    path = BUILTIN_TEMPLATE_ROOT / filename
    return json.loads(path.read_text(encoding="utf-8"))


SKILL_OPTIMIZATION_TEMPLATE = _load_builtin_template_payload("skill_optimization.json")
SKILL_OPTIMIZATION_TEMPLATE_ID = str(SKILL_OPTIMIZATION_TEMPLATE["id"])


def seed_builtin_templates(db: Session) -> None:
    """Seed or refresh built-in templates."""
    existing = (
        db.query(WorkflowTemplate)
        .filter(WorkflowTemplate.id == SKILL_OPTIMIZATION_TEMPLATE_ID)
        .first()
    )
    template_attrs = {
        "name": str(SKILL_OPTIMIZATION_TEMPLATE["name"]),
        "description": str(SKILL_OPTIMIZATION_TEMPLATE["description"]),
        "graph_template": copy.deepcopy(SKILL_OPTIMIZATION_TEMPLATE["graph_template"]),
        "required_skills": copy.deepcopy(SKILL_OPTIMIZATION_TEMPLATE["required_skills"]),
        "category": str(SKILL_OPTIMIZATION_TEMPLATE["category"]),
        "is_builtin": bool(SKILL_OPTIMIZATION_TEMPLATE.get("is_builtin", True)),
    }
    if existing is None:
        existing = WorkflowTemplate(id=SKILL_OPTIMIZATION_TEMPLATE_ID, **template_attrs)
        db.add(existing)
    else:
        for key, value in template_attrs.items():
            setattr(existing, key, value)
        db.add(existing)
    db.commit()

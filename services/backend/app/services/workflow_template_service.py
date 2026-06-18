"""Workflow Template Service — instantiates pre-defined workflow graphs.

Creates WorkflowDefinition + installs Skill files into the target project.
Does NOT create NativeAgents — inline agent nodes carry their own config.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..models import Folder, Project, WorkflowDefinition, WorkflowTemplate
from .project_fs_service import ProjectFsService


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

        1. Install required Skills into the project's .agents/skills/
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

        # Install required skills into the project
        installed_skills = self._install_skills(project, template.required_skills or [])

        # Create WorkflowDefinition
        graph = template.graph_template or {}
        wf_name = name or f"{template.name} (from template)"

        wf_def = WorkflowDefinition(
            project_id=project_id,
            user_id=user_id,
            name=wf_name,
            description=f"Auto-created from template: {template.name}",
            execution_mode="graph",
            graph=graph,
            config={"max_rounds": 3, "provider": {}},
        )
        self.db.add(wf_def)
        self.db.commit()
        self.db.refresh(wf_def)

        return TemplateInstantiationResult(
            workflow_definition_id=wf_def.id,
            workflow_name=wf_name,
            installed_skills=installed_skills,
        )

    def prepare(
        self,
        template_id: str,
        *,
        project_id: str,
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

        installed = self._install_skills(project, template.required_skills or [])

        return TemplatePrepareResult(
            installed_skills=installed,
            graph_template=template.graph_template,
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
        self, project: Project, required_skills: list[dict]
    ) -> list[str]:
        """Install required skills into the project's .agents/skills/ directory."""
        installed = []

        for skill_def in required_skills:
            skill_name = skill_def.get("name", "")
            skill_content = skill_def.get("content", "")
            if not skill_name or not skill_content:
                continue

            # Read content from file if it's a file path
            if skill_content.startswith("file:"):
                file_path = skill_content[5:]
                try:
                    skill_content = Path(file_path).read_text(encoding="utf-8")
                except OSError:
                    continue

            # Write SKILL.md into the project's file tree
            fs = ProjectFsService(self.db, project)

            # Create or find the skill folder
            skill_folder = (
                self.db.query(Folder)
                .filter(
                    Folder.project_id == project.id,
                    Folder.parent_folder_id.is_(None),
                    Folder.name == skill_name,
                )
                .first()
            )
            if skill_folder is None:
                skill_folder = fs.create_folder(
                    parent_folder_id=None, name=skill_name
                )

            # Write SKILL.md
            fs.create_doc(
                folder_id=skill_folder.id,
                name="SKILL.md",
                format="md",
                content=skill_content,
            )
            installed.append(skill_name)

        return installed


# ---------------------------------------------------------------------------
# Built-in template: skill-optimization-v1
# ---------------------------------------------------------------------------

SKILL_OPTIMIZATION_TEMPLATE_ID = "builtin-skill-optimization-v1"

SKILL_OPTIMIZATION_GRAPH = {
    "nodes": [
        {
            "id": "input",
            "type": "input",
            "label": "Input",
            "config": {},
            "_ui": {"position": {"x": 50, "y": 200}},
        },
        {
            "id": "signal-analyst",
            "type": "agent",
            "label": "Signal Analyst",
            "config": {
                "inline_agent": True,
                "skill_names": ["skill-signal-analyst"],
                "instructions": "你是信号分析 Agent。读取 _skill_data/ 中的标注数据，提取失败模式和好坏样例，输出诊断 JSON。",
                "allow_project_context": True,
                "provider_ref": "workflow_default",
            },
            "_ui": {"position": {"x": 300, "y": 100}},
        },
        {
            "id": "skill-rewriter",
            "type": "agent",
            "label": "Skill Rewriter",
            "config": {
                "inline_agent": True,
                "skill_names": ["skill-rewriter"],
                "instructions": "你是 Skill 改写 Agent。根据诊断结果，使用 skill_manage tool 改写 SKILL.md 和 references/。",
                "allow_project_context": True,
                "provider_ref": "workflow_default",
            },
            "_ui": {"position": {"x": 550, "y": 100}},
        },
        {
            "id": "skill-evaluator",
            "type": "agent",
            "label": "Skill Evaluator",
            "config": {
                "inline_agent": True,
                "skill_names": ["skill-evaluator"],
                "instructions": "你是评估 Agent。运行 eval cases，检查 Skill 优化效果，输出评估报告。",
                "allow_project_context": True,
                "provider_ref": "workflow_default",
            },
            "_ui": {"position": {"x": 800, "y": 100}},
        },
        {
            "id": "output",
            "type": "output",
            "label": "Output",
            "config": {},
            "_ui": {"position": {"x": 1050, "y": 200}},
        },
    ],
    "edges": [
        {"source": "input", "target": "signal-analyst"},
        {"source": "signal-analyst", "target": "skill-rewriter"},
        {"source": "skill-rewriter", "target": "skill-evaluator"},
        {"source": "skill-evaluator", "target": "output"},
    ],
}

SKILL_OPTIMIZATION_REQUIRED_SKILLS = [
    {
        "name": "skill-signal-analyst",
        "content": "file:/Volumes/DevLayer/YuwanLabWriter/supports/SuperLeaf.Skills/skills/skill-signal-analyst/SKILL.md",
    },
    {
        "name": "skill-rewriter",
        "content": "file:/Volumes/DevLayer/YuwanLabWriter/supports/SuperLeaf.Skills/skills/skill-rewriter/SKILL.md",
    },
    {
        "name": "skill-evaluator",
        "content": "file:/Volumes/DevLayer/YuwanLabWriter/supports/SuperLeaf.Skills/skills/skill-evaluator/SKILL.md",
    },
]


def seed_builtin_templates(db: Session) -> None:
    """Seed built-in templates if they don't exist."""
    existing = (
        db.query(WorkflowTemplate)
        .filter(WorkflowTemplate.id == SKILL_OPTIMIZATION_TEMPLATE_ID)
        .first()
    )
    if existing:
        return

    template = WorkflowTemplate(
        id=SKILL_OPTIMIZATION_TEMPLATE_ID,
        name="Skill Optimization Pipeline",
        description="数据驱动的 Skill 优化管线：信号分析 → Skill 改写 → 评估",
        graph_template=SKILL_OPTIMIZATION_GRAPH,
        required_skills=SKILL_OPTIMIZATION_REQUIRED_SKILLS,
        category="optimization",
        is_builtin=True,
    )
    db.add(template)
    db.commit()

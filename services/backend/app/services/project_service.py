"""Project-level CRUD + cascade delete.

Cascade delete is done in the service layer (one transaction, explicit
post-order) because SQLite FK CASCADE is unreliable without per-connection
`PRAGMA foreign_keys=ON`. Doing it explicitly also lets us nuke
project-scoped rows in tables that don't carry FKs to `projects` (Message
goes through Conversation).
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import (
    Conversation,
    DatasetBatch,
    DatasetProject,
    DatasetRecord,
    DatasetResponse,
    DatasetSourceRule,
    Doc,
    FileBlob,
    Folder,
    Message,
    Project,
    WorkflowDefinition,
    WorkflowRun,
)
from .project_fs_service import ProjectFsService

_DEFAULT_ASSET_FOLDER = "assets"
_DEFAULT_BANNER_NAME = "github-header-banner.png"
_DEFAULT_BANNER_MIME = "image/png"
_DEFAULT_TEMPLATE_NAME = "default-project-template.zip"

_DEFAULT_MAIN_TEX = r"""\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{graphicx}
\usepackage{hyperref}
\graphicspath{{assets/}}

\title{Welcome to SuperLeaf}
\author{}
\date{}

\begin{document}
\maketitle

\begin{center}
\includegraphics[width=0.9\linewidth]{github-header-banner.png}
\end{center}

\section{Start Writing}
Welcome to SuperLeaf, a LaTeX-first research writing workspace for
drafting, reviewing, and polishing academic work with native Agent support.

\section{What You Can Do Here}
\begin{itemize}
  \item Write in LaTeX or Markdown while keeping project files organized.
  \item Preview compiled output and iterate quickly on structure and style.
  \item Invite Agents into focused discussions, reviews, and workflow runs.
  \item Keep supporting figures, datasets, and notes under the project tree.
\end{itemize}

\section{Next Steps}
Replace this starter text with your paper outline, add your references and
figures, then use the workspace panels to review, compile, and refine your
draft.

\end{document}
"""

_DEFAULT_MAIN_MD = """![SuperLeaf banner](assets/github-header-banner.png)

# Welcome to SuperLeaf

SuperLeaf is a local-first research writing workspace built for drafting,
reviewing, and polishing academic documents with native Agent support.

## Start Here

- Use `main.tex` for a LaTeX-first manuscript.
- Use this `main.md` file for notes, planning, or Markdown-first drafts.
- Put images and other project assets in the `assets` folder.
- Invite Agents into the discussion and workflow panels when you want review,
  critique, or rewriting help.

## A Good First Outline

1. Problem and motivation
2. Related work
3. Method or system design
4. Experiments or evaluation
5. Results, limitations, and next steps

Replace this starter document with your own project brief whenever you are
ready.
"""

_DEFAULT_SKILL_README = """# Skill Project

This project is an editable local Skill package.

## Files

- `SKILL.md` contains the instructions and metadata the Agent reads.
- `README.md` is for human notes, examples, and maintenance context.

Update the Skill cache from the project major-version panel when you want
Agents using this Skill to pick up the latest files.
"""

_DEFAULT_SKILL_MD = """---
name: skill-project
description: Describe what this Skill helps the Agent do.
version: 0.1.0
---

# Skill Instructions

Describe when this Skill should be used and what rules the Agent must follow.

## Inputs

List the information the user should provide before the Agent applies this
Skill.

## Workflow

1. Inspect the user's request and any provided files.
2. Follow the constraints in this file.
3. Produce the requested output without inventing unsupported requirements.

## Constraints

- Keep domain-specific terminology grounded in user-provided wording.
- Ask for missing information when a safe assumption would change the result.
"""

_DEFAULT_DATASET_README = """# Data Project

This project collects Agent, Skill, and Workflow data for evaluation,
labeling, and export.

## Workflow

1. Add source rules that select data from projects, Agents, Skills, or Workflows.
2. Sync rules to append new dataset records while preserving old labels.
3. Review records, save labels, and export the package for evaluation or tuning.
"""

_DEFAULT_DATASET_SCHEMA = {
    "version": 1,
    "fields": [
        {"name": "chat", "type": "chat", "title": "Conversation"},
        {"name": "source_text", "type": "text", "title": "Source text"},
        {"name": "agent_output", "type": "text", "title": "Agent output"},
        {"name": "trace", "type": "json", "title": "Workflow trace"},
    ],
    "questions": [
        {
            "name": "task_success",
            "type": "label",
            "title": "Task success",
            "options": ["success", "partial", "failure", "unclear"],
            "required": True,
        },
        {
            "name": "helpfulness",
            "type": "rating",
            "title": "Helpfulness",
            "min": 1,
            "max": 5,
            "required": False,
        },
        {
            "name": "issues",
            "type": "multi_label",
            "title": "Issues",
            "options": [
                "incorrect",
                "missing_context",
                "formatting",
                "unsafe",
                "tool_error",
                "other",
            ],
        },
        {"name": "comments", "type": "text", "title": "Comments"},
        {
            "name": "training_candidate",
            "type": "label",
            "title": "Training candidate",
            "options": ["yes", "no"],
            "required": False,
        },
    ],
}
_DEFAULT_DATASET_GUIDELINES = (
    "Evaluate Agent behavior, mark issues, and flag samples that should improve "
    "Skills or Workflows."
)


def _default_banner_path() -> Path:
    return (
        Path(__file__).resolve().parents[4]
        / _DEFAULT_ASSET_FOLDER
        / _DEFAULT_BANNER_NAME
    )


def _default_template_path() -> Path:
    return (
        Path(__file__).resolve().parents[4]
        / _DEFAULT_ASSET_FOLDER
        / _DEFAULT_TEMPLATE_NAME
    )


def _read_default_banner() -> bytes:
    try:
        return _default_banner_path().read_bytes()
    except OSError:
        return b""


class LastProjectError(Exception):
    """Raised when the user tries to delete the only remaining project."""


class ProjectService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list(self, *, user_id: str) -> list[Project]:
        return (
            self.db.query(Project)
            .filter(Project.user_id == user_id)
            .order_by(Project.updated_at.desc(), Project.created_at.desc())
            .all()
        )

    def get(self, project_id: str, *, user_id: str) -> Project | None:
        p = self.db.get(Project, project_id)
        if p is None or p.user_id != user_id:
            return None
        return p

    def create(
        self,
        *,
        user_id: str,
        name: str,
        project_type: str = "paper",
        tags: list[str] | None = None,
    ) -> Project:
        normalized_type = project_type if project_type in {"paper", "skill", "data"} else "paper"
        is_skill = normalized_type == "skill"
        p = Project(
            name=name,
            user_id=user_id,
            project_type=normalized_type,
            is_skill_project=is_skill,
            tags=_clean_project_tags(tags or []),
        )
        self.db.add(p)
        self.db.flush()
        if is_skill:
            self._seed_skill_content(p)
            self.db.commit()
            self.db.refresh(p)
            return p
        if normalized_type == "data":
            self._seed_dataset_content(p)
            self.db.commit()
            self.db.refresh(p)
            return p
        if self._seed_template_content(p):
            self.db.refresh(p)
            return p
        self._seed_default_content(p)
        self.db.commit()
        self.db.refresh(p)
        return p

    def _seed_skill_content(self, project: Project) -> None:
        readme = Doc(
            project_id=project.id,
            folder_id=None,
            name="README.md",
            format="md",
            content=_DEFAULT_SKILL_README,
            version=1,
        )
        skill = Doc(
            project_id=project.id,
            folder_id=None,
            name="SKILL.md",
            format="md",
            content=_DEFAULT_SKILL_MD,
            version=1,
        )
        self.db.add_all([readme, skill])
        self.db.flush()
        project.main_doc_id = readme.id

    def _seed_dataset_content(self, project: Project) -> None:
        readme = Doc(
            project_id=project.id,
            folder_id=None,
            name="README.md",
            format="md",
            content=_DEFAULT_DATASET_README,
            version=1,
        )
        dataset = DatasetProject(
            project_id=project.id,
            user_id=project.user_id,
            name=project.name,
            guidelines=_DEFAULT_DATASET_GUIDELINES,
            label_schema=_DEFAULT_DATASET_SCHEMA,
        )
        self.db.add_all([readme, dataset])
        self.db.flush()
        project.main_doc_id = readme.id

    def _seed_template_content(self, project: Project) -> bool:
        try:
            template = _default_template_path().read_bytes()
            ProjectFsService(self.db, project).replace_from_zip(template)
        except (OSError, ValueError):
            return False
        return True

    def _seed_default_content(self, project: Project) -> None:
        main_tex = Doc(
            project_id=project.id,
            folder_id=None,
            name="main.tex",
            format="tex",
            content=_DEFAULT_MAIN_TEX,
            version=1,
        )
        main_md = Doc(
            project_id=project.id,
            folder_id=None,
            name="main.md",
            format="md",
            content=_DEFAULT_MAIN_MD,
            version=1,
        )
        assets = Folder(
            project_id=project.id,
            parent_folder_id=None,
            name=_DEFAULT_ASSET_FOLDER,
            sort_index=0,
        )

        self.db.add_all([main_tex, main_md, assets])
        self.db.flush()
        project.main_doc_id = main_tex.id

        banner = _read_default_banner()
        if banner:
            self.db.add(
                FileBlob(
                    project_id=project.id,
                    folder_id=assets.id,
                    name=_DEFAULT_BANNER_NAME,
                    mime_type=_DEFAULT_BANNER_MIME,
                    size_bytes=len(banner),
                    blob=banner,
                )
            )

    def update(
        self,
        project_id: str,
        *,
        user_id: str,
        name: str | None = None,
        main_doc_id: str | None = None,
        compiler: str | None = None,
        is_skill_project: bool | None = None,
        project_type: str | None = None,
        tags: list[str] | None = None,
    ) -> Project | None:
        p = self.db.get(Project, project_id)
        if p is None or p.user_id != user_id:
            return None
        if name is not None:
            p.name = name
        if main_doc_id is not None:
            p.main_doc_id = self._scoped_main_doc_id(p.id, main_doc_id)
        if compiler is not None:
            p.compiler = compiler
        if is_skill_project is not None:
            p.is_skill_project = bool(is_skill_project)
            p.project_type = "skill" if p.is_skill_project else "paper"
        if project_type is not None:
            normalized_type = project_type if project_type in {"paper", "skill", "data"} else p.project_type
            p.project_type = normalized_type
            p.is_skill_project = normalized_type == "skill"
        if tags is not None:
            p.tags = _clean_project_tags(tags)
        p.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(p)
        return p

    def _scoped_main_doc_id(self, project_id: str, main_doc_id: str) -> str:
        if not main_doc_id:
            return ""
        doc = self.db.get(Doc, main_doc_id)
        if doc is None or doc.project_id != project_id:
            raise ValueError("main_doc_id must belong to the current project")
        return doc.id

    def delete(self, project_id: str, *, user_id: str) -> bool:
        """Cascade-delete a project and all its scoped rows.

        Refuses if it's the user's last project (raises `LastProjectError`).
        Returns False if the project does not exist or belongs to someone else.
        """
        total = (
            self.db.query(Project).filter(Project.user_id == user_id).count()
        )
        if total <= 1:
            raise LastProjectError("cannot delete last project")

        p = self.db.get(Project, project_id)
        if p is None or p.user_id != user_id:
            return False

        # Delete in dependency-safe order; everything in one transaction.
        # Messages → through Conversations.
        conv_ids = [
            r[0]
            for r in self.db.query(Conversation.id)
            .filter(Conversation.project_id == project_id)
            .all()
        ]
        if conv_ids:
            self.db.query(Message).filter(Message.conversation_id.in_(conv_ids)).delete(
                synchronize_session=False
            )

        dataset_ids = [
            r[0]
            for r in self.db.query(DatasetProject.id)
            .filter(DatasetProject.project_id == project_id)
            .all()
        ]
        if dataset_ids:
            self.db.query(DatasetResponse).filter(
                DatasetResponse.dataset_project_id.in_(dataset_ids)
            ).delete(synchronize_session=False)
            self.db.query(DatasetRecord).filter(
                DatasetRecord.dataset_project_id.in_(dataset_ids)
            ).delete(synchronize_session=False)
            self.db.query(DatasetBatch).filter(
                DatasetBatch.dataset_project_id.in_(dataset_ids)
            ).delete(synchronize_session=False)
            self.db.query(DatasetSourceRule).filter(
                DatasetSourceRule.dataset_project_id.in_(dataset_ids)
            ).delete(synchronize_session=False)
            self.db.query(DatasetProject).filter(
                DatasetProject.id.in_(dataset_ids)
            ).delete(synchronize_session=False)

        source_rule_ids = [
            r[0]
            for r in self.db.query(DatasetSourceRule.id)
            .filter(DatasetSourceRule.source_project_id == project_id)
            .all()
        ]
        if source_rule_ids:
            self.db.query(DatasetBatch).filter(
                DatasetBatch.source_rule_id.in_(source_rule_ids)
            ).delete(synchronize_session=False)
            self.db.query(DatasetSourceRule).filter(
                DatasetSourceRule.id.in_(source_rule_ids)
            ).delete(synchronize_session=False)

        self.db.query(Conversation).filter(Conversation.project_id == project_id).delete(
            synchronize_session=False
        )
        self.db.query(WorkflowRun).filter(WorkflowRun.project_id == project_id).delete(
            synchronize_session=False
        )
        self.db.query(WorkflowDefinition).filter(
            WorkflowDefinition.project_id == project_id
        ).delete(synchronize_session=False)

        # Filesystem rows: docs + files first, then folders (post-order safe enough
        # since we're nuking the entire project — no parent/child cycles to worry about).
        self.db.query(Doc).filter(Doc.project_id == project_id).delete(
            synchronize_session=False
        )
        self.db.query(FileBlob).filter(FileBlob.project_id == project_id).delete(
            synchronize_session=False
        )
        self.db.query(Folder).filter(Folder.project_id == project_id).delete(
            synchronize_session=False
        )

        self.db.delete(p)
        self.db.commit()
        return True


def _clean_project_tags(tags: list[str]) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in tags or []:
        tag = str(raw).strip()
        if not tag:
            continue
        tag = tag[:32]
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(tag)
        if len(cleaned) >= 12:
            break
    return cleaned

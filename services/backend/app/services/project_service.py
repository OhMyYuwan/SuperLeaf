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

\title{Welcome to YuwanLabWriter}
\author{}
\date{}

\begin{document}
\maketitle

\begin{center}
\includegraphics[width=0.9\linewidth]{github-header-banner.png}
\end{center}

\section{Start Writing}
Welcome to YuwanLabWriter, a LaTeX-first research writing workspace for
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

_DEFAULT_MAIN_MD = """![YuwanLabWriter banner](assets/github-header-banner.png)

# Welcome to YuwanLabWriter

YuwanLabWriter is a local-first research writing workspace built for drafting,
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

    def create(self, *, user_id: str, name: str) -> Project:
        p = Project(name=name, user_id=user_id)
        self.db.add(p)
        self.db.flush()
        if self._seed_template_content(p):
            self.db.refresh(p)
            return p
        self._seed_default_content(p)
        self.db.commit()
        self.db.refresh(p)
        return p

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
    ) -> Project | None:
        p = self.db.get(Project, project_id)
        if p is None or p.user_id != user_id:
            return None
        if name is not None:
            p.name = name
        if main_doc_id is not None:
            p.main_doc_id = main_doc_id
        if compiler is not None:
            p.compiler = compiler
        p.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(p)
        return p

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

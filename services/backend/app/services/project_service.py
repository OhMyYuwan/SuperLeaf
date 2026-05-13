"""Project-level CRUD + cascade delete.

Cascade delete is done in the service layer (one transaction, explicit
post-order) because SQLite FK CASCADE is unreliable without per-connection
`PRAGMA foreign_keys=ON`. Doing it explicitly also lets us nuke
project-scoped rows in tables that don't carry FKs to `projects` (Message
goes through Conversation).
"""

from __future__ import annotations

from datetime import datetime

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
        self.db.commit()
        self.db.refresh(p)
        return p

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

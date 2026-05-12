"""User CRUD with cascade delete.

Deleting a user cascades through every per-user resource:
sessions → cached_workflows → providers → (per-project) docs/folders/files/
conversations/messages/workflow_runs/workflow_definitions → projects → user.

Refuses to delete the last admin (would lock everyone out of the admin
endpoints); raises `LastAdminError`.
"""

from __future__ import annotations

from sqlalchemy.orm import Session as DbSession

from ..models import (
    CachedWorkflow,
    Conversation,
    Doc,
    FileBlob,
    Folder,
    Message,
    Project,
    Provider,
    Session,
    User,
    WorkflowDefinition,
    WorkflowRun,
)


class LastAdminError(Exception):
    """Raised when removing the user would leave the system without any admin."""


class UserService:
    def __init__(self, db: DbSession) -> None:
        self.db = db

    def list(self) -> list[User]:
        return (
            self.db.query(User).order_by(User.created_at.asc()).all()
        )

    def get(self, user_id: str) -> User | None:
        return self.db.get(User, user_id)

    def update(
        self,
        user_id: str,
        *,
        is_disabled: bool | None = None,
        is_admin: bool | None = None,
        display_name: str | None = None,
    ) -> User | None:
        user = self.db.get(User, user_id)
        if user is None:
            return None
        # Block demoting the last admin.
        if is_admin is False and user.is_admin and self._admin_count() <= 1:
            raise LastAdminError("cannot demote the last admin")
        if is_disabled is not None:
            user.is_disabled = is_disabled
        if is_admin is not None:
            user.is_admin = is_admin
        if display_name is not None:
            user.display_name = display_name.strip()
        self.db.commit()
        self.db.refresh(user)
        return user

    def delete(self, user_id: str) -> bool:
        user = self.db.get(User, user_id)
        if user is None:
            return False
        if user.is_admin and self._admin_count() <= 1:
            raise LastAdminError("cannot delete the last admin")

        # Per-project cascade: gather project ids first.
        project_ids = [
            r[0]
            for r in self.db.query(Project.id).filter(Project.user_id == user_id).all()
        ]
        if project_ids:
            conv_ids = [
                r[0]
                for r in self.db.query(Conversation.id)
                .filter(Conversation.project_id.in_(project_ids))
                .all()
            ]
            if conv_ids:
                self.db.query(Message).filter(Message.conversation_id.in_(conv_ids)).delete(
                    synchronize_session=False
                )
            self.db.query(Conversation).filter(
                Conversation.project_id.in_(project_ids)
            ).delete(synchronize_session=False)
            self.db.query(WorkflowRun).filter(
                WorkflowRun.project_id.in_(project_ids)
            ).delete(synchronize_session=False)
            self.db.query(WorkflowDefinition).filter(
                WorkflowDefinition.project_id.in_(project_ids)
            ).delete(synchronize_session=False)
            self.db.query(Doc).filter(Doc.project_id.in_(project_ids)).delete(
                synchronize_session=False
            )
            self.db.query(FileBlob).filter(FileBlob.project_id.in_(project_ids)).delete(
                synchronize_session=False
            )
            self.db.query(Folder).filter(Folder.project_id.in_(project_ids)).delete(
                synchronize_session=False
            )
            self.db.query(Project).filter(Project.id.in_(project_ids)).delete(
                synchronize_session=False
            )

        self.db.query(CachedWorkflow).filter(CachedWorkflow.user_id == user_id).delete(
            synchronize_session=False
        )
        self.db.query(Provider).filter(Provider.user_id == user_id).delete(
            synchronize_session=False
        )
        self.db.query(Session).filter(Session.user_id == user_id).delete(
            synchronize_session=False
        )
        self.db.delete(user)
        self.db.commit()
        return True

    def _admin_count(self) -> int:
        return (
            self.db.query(User)
            .filter(User.is_admin == True, User.is_disabled == False)  # noqa: E712
            .count()
        )

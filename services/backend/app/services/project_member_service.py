"""Project member management service for multi-user collaboration."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Project, ProjectMember, RecentCollaborator, User


class ProjectMemberService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def add_member(
        self,
        project_id: str,
        user_email: str,
        role: str = "editor",
        invited_by_id: str | None = None,
    ) -> ProjectMember | None:
        """Add a user to a project by email. Returns None if user not found."""
        # Find user by email
        user = self.db.scalar(select(User).where(User.email == user_email))
        if user is None:
            return None

        # Check if already a member
        existing = self.db.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user.id,
            )
        )
        if existing:
            self.record_project_collaboration(project_id)
            self.db.commit()
            return existing

        member = ProjectMember(
            project_id=project_id,
            user_id=user.id,
            role=role,
            status="accepted",
            invited_by=invited_by_id,
        )
        self.db.add(member)
        self.db.flush()
        self.record_project_collaboration(project_id)
        self.db.commit()
        self.db.refresh(member)
        return member

    def list_recent_collaborators(
        self,
        owner_user_id: str,
        limit: int = 20,
    ) -> list[RecentCollaborator]:
        """List recently remembered collaborators for a user."""
        self.seed_recent_collaborators_for_user(owner_user_id)
        self.db.commit()
        stmt = (
            select(RecentCollaborator)
            .where(RecentCollaborator.owner_user_id == owner_user_id)
            .order_by(
                RecentCollaborator.last_collaborated_at.desc(),
                RecentCollaborator.updated_at.desc(),
            )
            .limit(max(1, min(limit, 100)))
        )
        return list(self.db.scalars(stmt).all())

    def seed_recent_collaborators_for_user(self, user_id: str) -> None:
        """Backfill recent collaborators from projects the user already shares."""
        project_ids = {
            row
            for row in self.db.scalars(
                select(Project.id).where(Project.user_id == user_id)
            ).all()
        }
        member_project_ids = self.db.scalars(
            select(ProjectMember.project_id).where(ProjectMember.user_id == user_id)
        ).all()
        project_ids.update(member_project_ids)
        for project_id in project_ids:
            self.record_project_collaboration(project_id)

    def record_project_collaboration(self, project_id: str) -> None:
        """Remember every current participant as a recent collaborator.

        The project owner and all accepted project members become visible in
        each other's recent collaborator lists. The caller owns the commit.
        """
        participants = self._project_participants(project_id)
        if len(participants) < 2:
            return
        for owner in participants:
            for collaborator in participants:
                if owner.id == collaborator.id:
                    continue
                self._remember_collaborator(owner.id, collaborator)

    def _project_participants(self, project_id: str) -> list[User]:
        project = self.db.get(Project, project_id)
        if project is None:
            return []

        participants: dict[str, User] = {}
        owner = self.db.get(User, project.user_id)
        if owner is not None:
            participants[owner.id] = owner

        member_users = (
            self.db.scalars(
                select(User)
                .join(ProjectMember, ProjectMember.user_id == User.id)
                .where(ProjectMember.project_id == project_id)
            )
            .all()
        )
        for user in member_users:
            participants[user.id] = user
        return list(participants.values())

    def _remember_collaborator(self, owner_user_id: str, collaborator: User) -> None:
        now = datetime.utcnow()
        row = self.db.scalar(
            select(RecentCollaborator).where(
                RecentCollaborator.owner_user_id == owner_user_id,
                RecentCollaborator.collaborator_user_id == collaborator.id,
            )
        )
        display_name = collaborator.display_name or collaborator.email
        if row is None:
            self.db.add(
                RecentCollaborator(
                    owner_user_id=owner_user_id,
                    collaborator_user_id=collaborator.id,
                    collaborator_email=collaborator.email,
                    collaborator_display_name=display_name,
                    last_collaborated_at=now,
                )
            )
            return

        row.collaborator_email = collaborator.email
        row.collaborator_display_name = display_name
        row.last_collaborated_at = now

    def list_members(self, project_id: str) -> list[tuple[ProjectMember, User]]:
        """List all members of a project with their user info."""
        stmt = (
            select(ProjectMember, User)
            .join(User, ProjectMember.user_id == User.id)
            .where(ProjectMember.project_id == project_id)
            .order_by(ProjectMember.created_at)
        )
        return list(self.db.execute(stmt).all())

    def remove_member(self, project_id: str, user_id: str) -> bool:
        """Remove a member from a project. Returns True if removed."""
        member = self.db.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user_id,
            )
        )
        if member is None:
            return False
        self.db.delete(member)
        self.db.commit()
        return True

    def is_member(self, project_id: str, user_id: str) -> bool:
        """Check if a user is a member of a project."""
        member = self.db.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user_id,
            )
        )
        return member is not None

    def has_access(self, project_id: str, user_id: str) -> bool:
        """Check if a user has access to a project (owner or member)."""
        # Check if owner
        project = self.db.scalar(
            select(Project).where(
                Project.id == project_id,
                Project.user_id == user_id,
            )
        )
        if project:
            return True
        # Check if member
        return self.is_member(project_id, user_id)

    def get_role(self, project_id: str, user_id: str) -> str | None:
        """Get user's role in a project. Returns 'owner', 'editor', 'viewer', or None."""
        project = self.db.scalar(
            select(Project).where(
                Project.id == project_id,
                Project.user_id == user_id,
            )
        )
        if project:
            return "owner"
        member = self.db.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user_id,
            )
        )
        if member:
            return member.role
        return None

    def can_write(self, project_id: str, user_id: str) -> bool:
        """Check if user can write to a project (owner or editor)."""
        role = self.get_role(project_id, user_id)
        return role in ("owner", "editor")

    def list_shared_projects(self, user_id: str) -> list[tuple[Project, ProjectMember]]:
        """List projects where user is a member (not owner)."""
        stmt = (
            select(Project, ProjectMember)
            .join(ProjectMember, Project.id == ProjectMember.project_id)
            .where(ProjectMember.user_id == user_id)
            .order_by(Project.updated_at.desc())
        )
        return list(self.db.execute(stmt).all())

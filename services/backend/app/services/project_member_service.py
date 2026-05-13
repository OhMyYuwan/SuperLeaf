"""Project member management service for multi-user collaboration."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Project, ProjectMember, User


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
            return existing

        member = ProjectMember(
            project_id=project_id,
            user_id=user.id,
            role=role,
            status="accepted",
            invited_by=invited_by_id,
        )
        self.db.add(member)
        self.db.commit()
        self.db.refresh(member)
        return member

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

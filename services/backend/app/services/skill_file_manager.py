"""Skill File Manager — Agent-managed Skill CRUD.

Ported from hermes-agent/tools/skill_manager_tool.py.
Adapted to use SuperLeaf's ProjectFsService for DB-backed file operations.

Actions: create, edit, patch, delete, write_file, remove_file
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy.orm import Session

from ..models import Doc, Folder, Project
from .project_fs_service import ProjectFsService

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants (from hermes)
# ---------------------------------------------------------------------------

MAX_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
MAX_SKILL_CONTENT_CHARS = 100_000  # ~36k tokens
MAX_SKILL_FILE_BYTES = 1_048_576   # 1 MiB per supporting file

VALID_NAME_RE = re.compile(r'^[a-z0-9][a-z0-9._-]*$')
ALLOWED_SUBDIRS = {"references", "templates", "scripts", "assets"}


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class SkillFileResult:
    success: bool
    message: str = ""
    error: str = ""
    path: str = ""
    details: dict | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"success": self.success}
        if self.message:
            d["message"] = self.message
        if self.error:
            d["error"] = self.error
        if self.path:
            d["path"] = self.path
        if self.details:
            d.update(self.details)
        return d


# ---------------------------------------------------------------------------
# Validation helpers (direct port from hermes)
# ---------------------------------------------------------------------------


def validate_name(name: str) -> str | None:
    """Validate a skill name. Returns error message or None if valid."""
    if not name:
        return "Skill name is required."
    if len(name) > MAX_NAME_LENGTH:
        return f"Skill name exceeds {MAX_NAME_LENGTH} characters."
    if not VALID_NAME_RE.match(name):
        return (
            f"Invalid skill name '{name}'. Use lowercase letters, numbers, "
            f"hyphens, dots, and underscores. Must start with a letter or digit."
        )
    return None


def validate_category(category: str | None) -> str | None:
    """Validate an optional category name."""
    if category is None:
        return None
    if not isinstance(category, str):
        return "Category must be a string."
    category = category.strip()
    if not category:
        return None
    if "/" in category or "\\" in category:
        return f"Invalid category '{category}'. Must be a single directory name."
    if len(category) > MAX_NAME_LENGTH:
        return f"Category exceeds {MAX_NAME_LENGTH} characters."
    if not VALID_NAME_RE.match(category):
        return f"Invalid category '{category}'. Must be a single directory name."
    return None


def validate_frontmatter(content: str) -> str | None:
    """Validate SKILL.md content has proper frontmatter. Returns error or None."""
    if not content.strip():
        return "Content cannot be empty."
    if not content.startswith("---"):
        return "SKILL.md must start with YAML frontmatter (---)."

    end_match = re.search(r'\n---\s*\n', content[3:])
    if not end_match:
        return "SKILL.md frontmatter is not closed."

    yaml_content = content[3:end_match.start() + 3]
    try:
        parsed = yaml.safe_load(yaml_content)
    except yaml.YAMLError as e:
        return f"YAML frontmatter parse error: {e}"

    if not isinstance(parsed, dict):
        return "Frontmatter must be a YAML mapping."
    if "name" not in parsed:
        return "Frontmatter must include 'name' field."
    if "description" not in parsed:
        return "Frontmatter must include 'description' field."
    if len(str(parsed["description"])) > MAX_DESCRIPTION_LENGTH:
        return f"Description exceeds {MAX_DESCRIPTION_LENGTH} characters."

    body = content[end_match.end() + 3:].strip()
    if not body:
        return "SKILL.md must have content after the frontmatter."
    return None


def validate_content_size(content: str, label: str = "SKILL.md") -> str | None:
    """Check content doesn't exceed character limit."""
    if len(content) > MAX_SKILL_CONTENT_CHARS:
        return (
            f"{label} content is {len(content):,} characters "
            f"(limit: {MAX_SKILL_CONTENT_CHARS:,}). "
            f"Consider splitting into supporting files."
        )
    return None


def validate_file_path(file_path: str) -> str | None:
    """Validate a file path for write_file/remove_file."""
    if not file_path:
        return "file_path is required."

    normalized = Path(file_path)

    # Prevent path traversal
    if ".." in normalized.parts:
        return "Path traversal ('..') is not allowed."

    # Must be under an allowed subdirectory
    if not normalized.parts or normalized.parts[0] not in ALLOWED_SUBDIRS:
        allowed = ", ".join(sorted(ALLOWED_SUBDIRS))
        return f"File must be under one of: {allowed}. Got: '{file_path}'"

    # Must have a filename
    if len(normalized.parts) < 2:
        return f"Provide a file path, not just a directory. Example: '{normalized.parts[0]}/myfile.md'"

    return None


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class SkillFileManager:
    """Agent-managed Skill CRUD using ProjectFsService.

    Operates on a Skill Project's file tree. All operations go through
    ProjectFsService for DB-backed persistence.
    """

    def __init__(self, db: Session, project: Project) -> None:
        self.db = db
        self.project = project
        self.fs = ProjectFsService(db, project)

    def execute(self, action: str, **kwargs) -> SkillFileResult:
        """Dispatch to the appropriate action handler."""
        handlers = {
            "create": self._create,
            "edit": self._edit,
            "patch": self._patch,
            "delete": self._delete,
            "write_file": self._write_file,
            "remove_file": self._remove_file,
        }
        handler = handlers.get(action)
        if handler is None:
            return SkillFileResult(
                success=False,
                error=f"Unknown action '{action}'. Valid: {', '.join(handlers)}",
            )
        try:
            return handler(**kwargs)
        except Exception as e:
            logger.exception("skill_manage action=%s failed", action)
            return SkillFileResult(success=False, error=str(e))

    # -------------------------------------------------------------------
    # create
    # -------------------------------------------------------------------

    def _create(
        self,
        name: str,
        content: str,
        category: str | None = None,
        **_kwargs,
    ) -> SkillFileResult:
        err = validate_name(name)
        if err:
            return SkillFileResult(success=False, error=err)

        err = validate_category(category)
        if err:
            return SkillFileResult(success=False, error=err)

        err = validate_frontmatter(content)
        if err:
            return SkillFileResult(success=False, error=err)

        err = validate_content_size(content)
        if err:
            return SkillFileResult(success=False, error=err)

        # Check if skill already exists
        existing = self._find_skill_folder(name)
        if existing:
            return SkillFileResult(
                success=False,
                error=f"A skill named '{name}' already exists.",
            )

        # Create folder structure
        parent_folder_id = None
        if category:
            cat_folder = self.fs.create_folder(
                parent_folder_id=None, name=category
            )
            parent_folder_id = cat_folder.id

        skill_folder = self.fs.create_folder(
            parent_folder_id=parent_folder_id, name=name
        )

        # Write SKILL.md
        self.fs.create_doc(
            folder_id=skill_folder.id,
            name="SKILL.md",
            format="md",
            content=content,
        )

        return SkillFileResult(
            success=True,
            message=f"Skill '{name}' created.",
            path=f"{category}/{name}" if category else name,
        )

    # -------------------------------------------------------------------
    # edit (full rewrite)
    # -------------------------------------------------------------------

    def _edit(self, name: str, content: str, **_kwargs) -> SkillFileResult:
        err = validate_frontmatter(content)
        if err:
            return SkillFileResult(success=False, error=err)

        err = validate_content_size(content)
        if err:
            return SkillFileResult(success=False, error=err)

        skill_folder = self._find_skill_folder(name)
        if not skill_folder:
            return SkillFileResult(
                success=False, error=f"Skill '{name}' not found."
            )

        skill_md = self._find_doc_in_folder(skill_folder.id, "SKILL.md")
        if skill_md:
            self.fs.update_doc_content(skill_md.id, content)
        else:
            self.fs.create_doc(
                folder_id=skill_folder.id,
                name="SKILL.md",
                format="md",
                content=content,
            )

        return SkillFileResult(
            success=True, message=f"Skill '{name}' updated."
        )

    # -------------------------------------------------------------------
    # patch (find-and-replace)
    # -------------------------------------------------------------------

    def _patch(
        self,
        name: str,
        old_string: str,
        new_string: str,
        file_path: str | None = None,
        replace_all: bool = False,
        **_kwargs,
    ) -> SkillFileResult:
        if not old_string:
            return SkillFileResult(
                success=False, error="old_string is required for 'patch'."
            )
        if new_string is None:
            return SkillFileResult(
                success=False, error="new_string is required for 'patch'."
            )

        skill_folder = self._find_skill_folder(name)
        if not skill_folder:
            return SkillFileResult(
                success=False, error=f"Skill '{name}' not found."
            )

        if file_path:
            err = validate_file_path(file_path)
            if err:
                return SkillFileResult(success=False, error=err)
            doc = self._find_supporting_file(skill_folder.id, file_path)
        else:
            doc = self._find_doc_in_folder(skill_folder.id, "SKILL.md")

        if not doc:
            return SkillFileResult(
                success=False,
                error=f"File not found: {file_path or 'SKILL.md'}",
            )

        content = doc.content or ""

        # Simple find-and-replace (no fuzzy match for now)
        if replace_all:
            new_content = content.replace(old_string, new_string)
            match_count = content.count(old_string)
        else:
            if old_string not in content:
                preview = content[:500] + ("..." if len(content) > 500 else "")
                return SkillFileResult(
                    success=False,
                    error=f"old_string not found in {file_path or 'SKILL.md'}.",
                    details={"file_preview": preview},
                )
            new_content = content.replace(old_string, new_string, 1)
            match_count = 1

        # Validate result
        if not file_path:
            err = validate_frontmatter(new_content)
            if err:
                return SkillFileResult(
                    success=False,
                    error=f"Patch would break SKILL.md structure: {err}",
                )

        err = validate_content_size(new_content, label=file_path or "SKILL.md")
        if err:
            return SkillFileResult(success=False, error=err)

        self.fs.update_doc_content(doc.id, new_content)
        return SkillFileResult(
            success=True,
            message=f"Patched {file_path or 'SKILL.md'} in skill '{name}' "
            f"({match_count} replacement{'s' if match_count > 1 else ''}).",
        )

    # -------------------------------------------------------------------
    # delete
    # -------------------------------------------------------------------

    def _delete(self, name: str, **_kwargs) -> SkillFileResult:
        skill_folder = self._find_skill_folder(name)
        if not skill_folder:
            return SkillFileResult(
                success=False, error=f"Skill '{name}' not found."
            )

        self.fs.delete_entity("folder", skill_folder.id)
        return SkillFileResult(
            success=True, message=f"Skill '{name}' deleted."
        )

    # -------------------------------------------------------------------
    # write_file
    # -------------------------------------------------------------------

    def _write_file(
        self, name: str, file_path: str, file_content: str, **_kwargs
    ) -> SkillFileResult:
        err = validate_file_path(file_path)
        if err:
            return SkillFileResult(success=False, error=err)

        if file_content is None:
            return SkillFileResult(
                success=False, error="file_content is required."
            )

        content_bytes = len(file_content.encode("utf-8"))
        if content_bytes > MAX_SKILL_FILE_BYTES:
            return SkillFileResult(
                success=False,
                error=f"File content is {content_bytes:,} bytes "
                f"(limit: {MAX_SKILL_FILE_BYTES:,} bytes / 1 MiB).",
            )

        skill_folder = self._find_skill_folder(name)
        if not skill_folder:
            return SkillFileResult(
                success=False,
                error=f"Skill '{name}' not found. Create it first.",
            )

        # Ensure subdirectory exists
        parts = Path(file_path).parts
        sub_dir_name = parts[0]
        sub_folder = self._ensure_subfolder(skill_folder.id, sub_dir_name)

        # Create nested subdirectories if needed
        current_folder = sub_folder
        for part in parts[1:-1]:
            current_folder = self._ensure_subfolder(current_folder.id, part)

        # Write the file
        file_name = parts[-1]
        self.fs.create_doc(
            folder_id=current_folder.id,
            name=file_name,
            format="md" if file_name.endswith(".md") else "txt",
            content=file_content,
        )

        return SkillFileResult(
            success=True,
            message=f"File '{file_path}' written to skill '{name}'.",
        )

    # -------------------------------------------------------------------
    # remove_file
    # -------------------------------------------------------------------

    def _remove_file(self, name: str, file_path: str, **_kwargs) -> SkillFileResult:
        err = validate_file_path(file_path)
        if err:
            return SkillFileResult(success=False, error=err)

        skill_folder = self._find_skill_folder(name)
        if not skill_folder:
            return SkillFileResult(
                success=False, error=f"Skill '{name}' not found."
            )

        doc = self._find_supporting_file(skill_folder.id, file_path)
        if not doc:
            return SkillFileResult(
                success=False,
                error=f"File '{file_path}' not found in skill '{name}'.",
            )

        self.db.delete(doc)
        self.db.commit()
        return SkillFileResult(
            success=True,
            message=f"File '{file_path}' removed from skill '{name}'.",
        )

    # -------------------------------------------------------------------
    # Internal helpers
    # -------------------------------------------------------------------

    def _find_skill_folder(self, name: str) -> Folder | None:
        """Find a skill folder by name at the project root level."""
        return (
            self.db.query(Folder)
            .filter(
                Folder.project_id == self.project.id,
                Folder.parent_folder_id.is_(None),
                Folder.name == name,
            )
            .first()
        )

    def _find_doc_in_folder(self, folder_id: str, name: str) -> Doc | None:
        """Find a doc by name in a specific folder."""
        return (
            self.db.query(Doc)
            .filter(
                Doc.project_id == self.project.id,
                Doc.folder_id == folder_id,
                Doc.name == name,
            )
            .first()
        )

    def _find_supporting_file(
        self, skill_folder_id: str, file_path: str
    ) -> Doc | None:
        """Find a supporting file by path relative to the skill folder."""
        parts = Path(file_path).parts
        current_folder_id = skill_folder_id

        # Navigate through subdirectories
        for part in parts[:-1]:
            folder = (
                self.db.query(Folder)
                .filter(
                    Folder.project_id == self.project.id,
                    Folder.parent_folder_id == current_folder_id,
                    Folder.name == part,
                )
                .first()
            )
            if not folder:
                return None
            current_folder_id = folder.id

        # Find the file
        return self._find_doc_in_folder(current_folder_id, parts[-1])

    def _ensure_subfolder(self, parent_id: str, name: str) -> Folder:
        """Find or create a subfolder."""
        existing = (
            self.db.query(Folder)
            .filter(
                Folder.project_id == self.project.id,
                Folder.parent_folder_id == parent_id,
                Folder.name == name,
            )
            .first()
        )
        if existing:
            return existing
        return self.fs.create_folder(parent_folder_id=parent_id, name=name)

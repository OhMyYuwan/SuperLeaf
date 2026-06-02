"""Attach Data Project packages to Skill Projects for optimization work."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..models import DatasetProject, Doc, Folder, Project, User
from .dataset_service import DatasetService
from .project_fs_service import ProjectFsService, SKILL_DATA_FOLDER_NAME

SKILL_DATA_LATEST_FOLDER_NAME = "latest"
SKILL_DATA_README = "README.md"
SKILL_DATA_BRIEF = "optimization-brief.md"


@dataclass(frozen=True)
class SkillDataHandoffResult:
    dataset_project_id: str
    dataset_name: str
    status_filter: str
    record_count: int
    folder: str
    files: list[dict[str, Any]]
    generated_at: str


@dataclass(frozen=True)
class SkillDataClearResult:
    folder: str
    deleted_count: int


class SkillDataHandoffService:
    """Write selected Data Project export files into a private Skill input folder.

    The folder is intentionally part of the editable project tree so users and
    optimization Agents can inspect it, but ProjectFsService excludes it from
    Skill cache and project ZIP export.
    """

    def __init__(self, db: Session) -> None:
        self.db = db

    def attach_dataset_package(
        self,
        *,
        skill_project: Project,
        data_project: Project,
        user: User,
        status: str = "submitted",
    ) -> SkillDataHandoffResult:
        if not (skill_project.project_type == "skill" or skill_project.is_skill_project):
            raise ValueError("Current project is not a Skill Project")
        if data_project.project_type != "data":
            raise ValueError("Selected project is not a Data Project")

        dataset = (
            self.db.query(DatasetProject)
            .filter(DatasetProject.project_id == data_project.id)
            .first()
        )
        if dataset is None:
            raise ValueError("Data Project has not been initialized")

        package_files, manifest = DatasetService(self.db).export_package_files(
            dataset,
            user=user,
            status=status,
        )
        generated_at = datetime.utcnow().isoformat()
        fs = ProjectFsService(self.db, skill_project)
        root_folder = self._ensure_folder(
            fs,
            project=skill_project,
            parent_folder_id=None,
            name=SKILL_DATA_FOLDER_NAME,
        )
        fs.create_doc(
            folder_id=root_folder.id,
            name=SKILL_DATA_README,
            format="md",
            content=_root_readme_content(),
        )
        data_folder_name = self._data_folder_name(
            root_folder=root_folder,
            data_project=data_project,
            dataset=dataset,
        )
        existing_data_folder = self._find_data_folder(
            root_folder=root_folder,
            data_project_id=data_project.id,
            fallback_name=data_folder_name,
        )
        if existing_data_folder is not None:
            fs.delete_entity("folder", existing_data_folder.id)
        data_folder = fs.create_folder(
            parent_folder_id=root_folder.id,
            name=data_folder_name,
        )
        fs.create_doc(
            folder_id=data_folder.id,
            name=SKILL_DATA_README,
            format="md",
            content=_data_readme_content(data_project=data_project, generated_at=generated_at),
        )
        latest_folder = self._replace_child_folder(
            fs,
            project=skill_project,
            parent_folder_id=data_folder.id,
            name=SKILL_DATA_LATEST_FOLDER_NAME,
        )

        written: list[dict[str, Any]] = []
        brief = _brief_content(
            data_project=data_project,
            dataset=dataset,
            manifest=manifest,
            generated_at=generated_at,
        )
        for name, content in {
            SKILL_DATA_BRIEF: brief,
            **package_files,
        }.items():
            doc = fs.create_doc(
                folder_id=latest_folder.id,
                name=name,
                format="md" if name.endswith(".md") else "txt",
                content=content,
            )
            written.append(
                {
                    "path": (
                        f"{SKILL_DATA_FOLDER_NAME}/{data_folder.name}/"
                        f"{SKILL_DATA_LATEST_FOLDER_NAME}/{name}"
                    ),
                    "kind": "doc",
                    "size_bytes": len((doc.content or "").encode("utf-8")),
                }
            )

        readme = _data_readme_content(data_project=data_project, generated_at=generated_at)
        return SkillDataHandoffResult(
            dataset_project_id=data_project.id,
            dataset_name=dataset.name or data_project.name,
            status_filter=str(manifest["status_filter"]),
            record_count=int(manifest["record_count"]),
            folder=f"{SKILL_DATA_FOLDER_NAME}/{data_folder.name}/{SKILL_DATA_LATEST_FOLDER_NAME}",
            files=[
                {
                    "path": f"{SKILL_DATA_FOLDER_NAME}/{data_folder.name}/{SKILL_DATA_README}",
                    "kind": "doc",
                    "size_bytes": len(readme.encode("utf-8")),
                },
                *written,
            ],
            generated_at=generated_at,
        )

    def clear_dataset_package(
        self,
        *,
        skill_project: Project,
        data_project: Project | None = None,
    ) -> SkillDataClearResult:
        if not (skill_project.project_type == "skill" or skill_project.is_skill_project):
            raise ValueError("Current project is not a Skill Project")
        folder = (
            self.db.query(Folder)
            .filter(
                Folder.project_id == skill_project.id,
                Folder.parent_folder_id.is_(None),
                Folder.name == SKILL_DATA_FOLDER_NAME,
            )
            .first()
        )
        if folder is None:
            return SkillDataClearResult(folder=SKILL_DATA_FOLDER_NAME, deleted_count=0)
        target = folder
        if data_project is not None:
            target = self._find_data_folder(
                root_folder=folder,
                data_project_id=data_project.id,
                fallback_name=_safe_folder_name(data_project.name),
            )
            if target is None:
                return SkillDataClearResult(
                    folder=f"{SKILL_DATA_FOLDER_NAME}/{_safe_folder_name(data_project.name)}",
                    deleted_count=0,
                )
        deleted_count = ProjectFsService(self.db, skill_project).delete_entity("folder", target.id)
        folder_path = (
            SKILL_DATA_FOLDER_NAME
            if data_project is None
            else f"{SKILL_DATA_FOLDER_NAME}/{target.name}"
        )
        return SkillDataClearResult(
            folder=folder_path,
            deleted_count=deleted_count,
        )

    def _ensure_folder(
        self,
        fs: ProjectFsService,
        *,
        project: Project,
        parent_folder_id: str | None,
        name: str,
    ) -> Folder:
        existing = (
            self.db.query(Folder)
            .filter(
                Folder.project_id == project.id,
                Folder.parent_folder_id == parent_folder_id,
                Folder.name == name,
            )
            .first()
        )
        if existing is not None:
            return existing
        return fs.create_folder(parent_folder_id=parent_folder_id, name=name)

    def _replace_child_folder(
        self,
        fs: ProjectFsService,
        *,
        project: Project,
        parent_folder_id: str,
        name: str,
    ) -> Folder:
        existing = (
            self.db.query(Folder)
            .filter(
                Folder.project_id == project.id,
                Folder.parent_folder_id == parent_folder_id,
                Folder.name == name,
            )
            .first()
        )
        if existing is not None:
            fs.delete_entity("folder", existing.id)
        return fs.create_folder(parent_folder_id=parent_folder_id, name=name)

    def _data_folder_name(
        self,
        *,
        root_folder: Folder,
        data_project: Project,
        dataset: DatasetProject,
    ) -> str:
        base_name = _safe_folder_name(dataset.name or data_project.name)
        existing = (
            self.db.query(Folder)
            .filter(
                Folder.project_id == root_folder.project_id,
                Folder.parent_folder_id == root_folder.id,
                Folder.name == base_name,
            )
            .first()
        )
        if existing is None or self._folder_data_project_id(existing) in {None, data_project.id}:
            return base_name
        return _safe_folder_name(f"{base_name}-{data_project.id[:8]}")

    def _find_data_folder(
        self,
        *,
        root_folder: Folder,
        data_project_id: str,
        fallback_name: str,
    ) -> Folder | None:
        children = (
            self.db.query(Folder)
            .filter(
                Folder.project_id == root_folder.project_id,
                Folder.parent_folder_id == root_folder.id,
            )
            .all()
        )
        for child in children:
            if self._folder_data_project_id(child) == data_project_id:
                return child
        return next((child for child in children if child.name == fallback_name), None)

    def _folder_data_project_id(self, folder: Folder) -> str | None:
        latest = (
            self.db.query(Folder)
            .filter(
                Folder.project_id == folder.project_id,
                Folder.parent_folder_id == folder.id,
                Folder.name == SKILL_DATA_LATEST_FOLDER_NAME,
            )
            .first()
        )
        if latest is None:
            return None
        manifest = (
            self.db.query(Doc)
            .filter(
                Doc.project_id == folder.project_id,
                Doc.folder_id == latest.id,
                Doc.name == "manifest.json",
            )
            .first()
        )
        if manifest is None:
            return None
        try:
            payload = json.loads(manifest.content or "{}")
        except json.JSONDecodeError:
            return None
        project_id = payload.get("project_id")
        return project_id if isinstance(project_id, str) else None


def _root_readme_content() -> str:
    return f"""# Skill Optimization Data

This folder stores isolated Data Project inputs for Skill optimization.

Each Data Project is stored in its own named subfolder:

`{SKILL_DATA_FOLDER_NAME}/<Data Project name>/{SKILL_DATA_LATEST_FOLDER_NAME}/`

These files are visible to optimization Agents, but they are excluded from
Skill cache, public Skill packages, and project ZIP export.
"""


def _data_readme_content(*, data_project: Project, generated_at: str) -> str:
    return f"""# Skill Optimization Data

This folder is an isolated optimization input area for this Skill Project.

- Source Data Project: {data_project.name}
- Generated at: {generated_at}
- Included in Skill cache: no
- Included in public Skill packages: no
- Included in project ZIP export: no

Use the files under `latest/` to evaluate and improve `SKILL.md`, references,
and evals. Do not copy raw records into published Skill instructions.
"""


def _brief_content(
    *,
    data_project: Project,
    dataset: DatasetProject,
    manifest: dict[str, Any],
    generated_at: str,
) -> str:
    return f"""# Data Project Optimization Brief

Data Project: {dataset.name or data_project.name}
Status filter: {manifest["status_filter"]}
Record count: {manifest["record_count"]}
Generated at: {generated_at}

Recommended path:

1. Read `labeled_samples.jsonl` first for human-approved signal.
2. Compare failures and successful examples against the current `SKILL.md`.
3. Update Skill instructions, references, and evals with distilled patterns.
4. Keep raw rows inside `_skill_data/`; do not copy them into public Skill files.
"""


def _safe_folder_name(name: str) -> str:
    cleaned = "".join("_" if ch in '/\\:\0' else ch for ch in name).strip()
    if cleaned in {"", ".", ".."}:
        return "dataset"
    return cleaned

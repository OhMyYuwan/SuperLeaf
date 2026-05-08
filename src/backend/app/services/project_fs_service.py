"""Local project filesystem service (A1).

This service models an Overleaf-like single project tree backed by SQLite,
not by real files on disk. All entities are rows; export-to-zip will be added
later using this tree as the source of truth.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from sqlalchemy.orm import Session

from ..models import Doc, FileBlob, Folder, Project
from ..schemas import ProjectTreeOut, TreeDocOut, TreeFileOut, TreeFolderOut

DEFAULT_PROJECT_NAME = "My Project"


class ProjectFsService:
    def __init__(self, db: Session) -> None:
        self.db = db

    # ------------------------------------------------------------------ setup

    def ensure_default_project(self) -> Project:
        """Ensure there is one default project row and return it."""
        existing = self.db.query(Project).order_by(Project.created_at.asc()).first()
        if existing:
            return existing
        p = Project(name=DEFAULT_PROJECT_NAME)
        self.db.add(p)
        self.db.commit()
        self.db.refresh(p)
        return p

    # ------------------------------------------------------------------- tree

    def get_tree(self) -> ProjectTreeOut:
        project = self.ensure_default_project()

        folders = (
            self.db.query(Folder)
            .filter(Folder.project_id == project.id)
            .order_by(Folder.sort_index.asc(), Folder.name.asc())
            .all()
        )
        docs = (
            self.db.query(Doc)
            .filter(Doc.project_id == project.id)
            .order_by(Doc.name.asc())
            .all()
        )
        files = (
            self.db.query(FileBlob)
            .filter(FileBlob.project_id == project.id)
            .order_by(FileBlob.name.asc())
            .all()
        )

        folders_by_parent: dict[str | None, list[Folder]] = defaultdict(list)
        docs_by_folder: dict[str | None, list[Doc]] = defaultdict(list)
        files_by_folder: dict[str | None, list[FileBlob]] = defaultdict(list)

        for f in folders:
            folders_by_parent[f.parent_folder_id].append(f)
        for d in docs:
            docs_by_folder[d.folder_id].append(d)
        for f in files:
            files_by_folder[f.folder_id].append(f)

        def build_folder_node(folder_id: str | None, name: str, is_virtual_root: bool = False) -> TreeFolderOut:
            children_folders = []
            if not is_virtual_root:
                candidate_children = folders_by_parent.get(folder_id, [])
            else:
                candidate_children = folders_by_parent.get(None, [])

            for child in candidate_children:
                children_folders.append(build_folder_node(child.id, child.name))

            if is_virtual_root:
                doc_rows = docs_by_folder.get(None, [])
                file_rows = files_by_folder.get(None, [])
                node_id = "root"
            else:
                doc_rows = docs_by_folder.get(folder_id, [])
                file_rows = files_by_folder.get(folder_id, [])
                node_id = folder_id or "root"

            return TreeFolderOut(
                id=node_id,
                name=name,
                folders=children_folders,
                docs=[
                    TreeDocOut(
                        id=d.id,
                        name=d.name,
                        format=d.format,
                        updated_at=d.updated_at,
                    )
                    for d in doc_rows
                ],
                files=[
                    TreeFileOut(
                        id=f.id,
                        name=f.name,
                        mime_type=f.mime_type,
                        size_bytes=f.size_bytes,
                        updated_at=f.updated_at,
                    )
                    for f in file_rows
                ],
            )

        root = build_folder_node(None, project.name, is_virtual_root=True)
        return ProjectTreeOut(project_id=project.id, project_name=project.name, root=root)

    # --------------------------------------------------------------- folder/doc

    def create_folder(self, *, parent_folder_id: str | None, name: str) -> Folder:
        project = self.ensure_default_project()
        if parent_folder_id:
            parent = self.db.get(Folder, parent_folder_id)
            if parent is None or parent.project_id != project.id:
                raise ValueError("parent folder not found")

        max_sort = (
            self.db.query(Folder)
            .filter(
                Folder.project_id == project.id,
                Folder.parent_folder_id == parent_folder_id,
            )
            .order_by(Folder.sort_index.desc())
            .first()
        )
        next_sort = (max_sort.sort_index + 1) if max_sort else 0

        folder = Folder(
            project_id=project.id,
            parent_folder_id=parent_folder_id,
            name=name,
            sort_index=next_sort,
        )
        self.db.add(folder)
        self.db.commit()
        self.db.refresh(folder)
        return folder

    def create_doc(self, *, folder_id: str | None, name: str, format: str, content: str) -> Doc:
        project = self.ensure_default_project()
        if folder_id:
            folder = self.db.get(Folder, folder_id)
            if folder is None or folder.project_id != project.id:
                raise ValueError("folder not found")

        doc = Doc(
            project_id=project.id,
            folder_id=folder_id,
            name=name,
            format=format,
            content=content,
            version=1,
        )
        self.db.add(doc)
        self.db.commit()
        self.db.refresh(doc)
        return doc

    def get_doc(self, doc_id: str) -> Doc | None:
        return self.db.get(Doc, doc_id)

    def update_doc_content(self, doc_id: str, content: str) -> Doc | None:
        doc = self.db.get(Doc, doc_id)
        if doc is None:
            return None
        doc.content = content
        doc.version += 1
        doc.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(doc)
        return doc

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
from . import version_service

class ProjectFsService:
    def __init__(self, db: Session, project: Project) -> None:
        self.db = db
        self.project = project

    # ------------------------------------------------------------------- tree

    def get_tree(self) -> ProjectTreeOut:
        project = self.project

        folders = (
            self.db.query(Folder)
            .filter(Folder.project_id == project.id)
            .order_by(Folder.name.asc())
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
                        size_bytes=len((d.content or "").encode("utf-8")),
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

    def rename_project(self, name: str) -> Project:
        project = self.project
        project.name = name
        project.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(project)
        return project

    # --------------------------------------------------------------- folder/doc

    def create_folder(self, *, parent_folder_id: str | None, name: str) -> Folder:
        project = self.project
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
        project = self.project
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

    def update_doc_content(
        self,
        doc_id: str,
        content: str,
        *,
        origin: str = "auto_save",
        actor: str | None = None,
    ) -> Doc | None:
        doc = self.db.get(Doc, doc_id)
        if doc is None:
            return None
        doc.content = content
        doc.version += 1
        doc.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(doc)
        # Snapshot for the V3 history pipeline. Cooldown/LRU live inside
        # version_service; this call is cheap when the autosave path keeps
        # firing with no meaningful change.
        version_service.snapshot(
            self.db,
            doc_id,
            content.encode("utf-8"),
            origin=origin,
            actor=actor,
        )
        return doc

    # --------------------------------------------------------- rename / delete

    def rename_entity(self, entity_type: str, entity_id: str, new_name: str) -> bool:
        model = {"folder": Folder, "doc": Doc, "file": FileBlob}.get(entity_type)
        if model is None:
            return False
        entity = self.db.get(model, entity_id)
        if entity is None:
            return False
        entity.name = new_name  # type: ignore[union-attr]
        entity.updated_at = datetime.utcnow()  # type: ignore[union-attr]
        self.db.commit()
        return True

    def move_entity(
        self, entity_type: str, entity_id: str, target_folder_id: str | None
    ) -> tuple[bool, str | None]:
        """Move a folder/doc/file under a new parent folder.

        Returns (ok, error_message). target_folder_id None means project root.
        """
        project = self.project

        if target_folder_id is not None:
            target = self.db.get(Folder, target_folder_id)
            if target is None or target.project_id != project.id:
                return False, "target folder not found"

        if entity_type == "folder":
            folder = self.db.get(Folder, entity_id)
            if folder is None or folder.project_id != project.id:
                return False, "folder not found"
            if target_folder_id == entity_id:
                return False, "cannot move folder into itself"
            # Prevent cycles: walk target's ancestors; if we hit entity_id, reject.
            ancestor_id = target_folder_id
            while ancestor_id is not None:
                if ancestor_id == entity_id:
                    return False, "cannot move folder into its descendant"
                ancestor = self.db.get(Folder, ancestor_id)
                ancestor_id = ancestor.parent_folder_id if ancestor else None
            if folder.parent_folder_id == target_folder_id:
                return True, None  # no-op
            folder.parent_folder_id = target_folder_id
            folder.updated_at = datetime.utcnow()
        elif entity_type == "doc":
            doc = self.db.get(Doc, entity_id)
            if doc is None or doc.project_id != project.id:
                return False, "doc not found"
            doc.folder_id = target_folder_id
            doc.updated_at = datetime.utcnow()
        elif entity_type == "file":
            f = self.db.get(FileBlob, entity_id)
            if f is None or f.project_id != project.id:
                return False, "file not found"
            f.folder_id = target_folder_id
            f.updated_at = datetime.utcnow()
        else:
            return False, "invalid entity type"

        self.db.commit()
        return True, None

    def delete_entity(self, entity_type: str, entity_id: str) -> int:
        """Delete an entity and return the count of deleted rows (recursive for folders)."""
        if entity_type == "folder":
            return self._delete_folder_recursive(entity_id)
        model = {"doc": Doc, "file": FileBlob}.get(entity_type)
        if model is None:
            return 0
        entity = self.db.get(model, entity_id)
        if entity is None:
            return 0
        self.db.delete(entity)
        self.db.commit()
        return 1

    def _delete_folder_recursive(self, folder_id: str) -> int:
        folder = self.db.get(Folder, folder_id)
        if folder is None:
            return 0
        count = 0
        for child in self.db.query(Folder).filter(Folder.parent_folder_id == folder_id).all():
            count += self._delete_folder_recursive(child.id)
        count += self.db.query(Doc).filter(Doc.folder_id == folder_id).delete()
        count += self.db.query(FileBlob).filter(FileBlob.folder_id == folder_id).delete()
        self.db.delete(folder)
        count += 1
        self.db.commit()
        return count

    # --------------------------------------------------------- binary upload

    def upload_file(
        self,
        *,
        folder_id: str | None,
        name: str,
        mime_type: str,
        blob: bytes,
    ) -> FileBlob:
        project = self.project
        if folder_id:
            folder = self.db.get(Folder, folder_id)
            if folder is None or folder.project_id != project.id:
                raise ValueError("folder not found")
        f = FileBlob(
            project_id=project.id,
            folder_id=folder_id,
            name=name,
            mime_type=mime_type,
            size_bytes=len(blob),
            blob=blob,
        )
        self.db.add(f)
        self.db.commit()
        self.db.refresh(f)
        return f

    # --------------------------------------------------------- export zip

    def export_zip(self) -> bytes:
        """Build an in-memory zip of the entire project tree."""
        import io
        import zipfile

        project = self.project
        buf = io.BytesIO()

        folders = self.db.query(Folder).filter(Folder.project_id == project.id).all()
        docs = self.db.query(Doc).filter(Doc.project_id == project.id).all()
        files = self.db.query(FileBlob).filter(FileBlob.project_id == project.id).all()

        folder_paths: dict[str, str] = {}
        for f in folders:
            folder_paths[f.id] = f.name

        def resolve_path(folder_id: str | None) -> str:
            parts: list[str] = []
            fid = folder_id
            visited: set[str] = set()
            while fid and fid in folder_paths and fid not in visited:
                visited.add(fid)
                parts.append(folder_paths[fid])
                parent = next((f for f in folders if f.id == fid), None)
                fid = parent.parent_folder_id if parent else None
            parts.reverse()
            return "/".join(parts)

        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for d in docs:
                prefix = resolve_path(d.folder_id)
                path = f"{prefix}/{d.name}" if prefix else d.name
                zf.writestr(path, d.content or "")
            for f in files:
                prefix = resolve_path(f.folder_id)
                path = f"{prefix}/{f.name}" if prefix else f.name
                zf.writestr(path, f.blob or b"")

        return buf.getvalue()

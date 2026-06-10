"""Local project filesystem service (A1).

This service models an Overleaf-like single project tree backed by SQLite,
not by real files on disk. All entities are rows; export-to-zip will be added
later using this tree as the source of truth.
"""

from __future__ import annotations

import io
import mimetypes
import shutil
import stat
import tempfile
import zipfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path, PurePosixPath

from sqlalchemy.orm import Session, load_only

from ..models import Doc, FileBlob, Folder, Project
from ..schemas import ProjectTreeOut, TreeDocOut, TreeFileOut, TreeFolderOut
from . import version_service
from .project_entry_name import validate_project_entry_name

_MAX_ZIP_UPLOAD_BYTES = 100 * 1024 * 1024
_MAX_ZIP_ENTRIES = 5000
_MAX_ZIP_EXPANDED_BYTES = 250 * 1024 * 1024
_DOC_SUFFIX_FORMATS = {
    ".tex": "tex",
    ".latex": "tex",
    ".ltx": "tex",
    ".bib": "tex",
    ".sty": "tex",
    ".cls": "tex",
    ".bst": "tex",
    ".md": "md",
    ".markdown": "md",
    ".txt": "txt",
}


def doc_format_for_name(name: str) -> str:
    """Return the editor highlight format for a text doc by its filename.

    Maps known suffixes to tex/md; every other (text) file defaults to txt.
    The text/binary split is decided separately by is_text_payload — this
    function only chooses the highlight language for files already known to
    be text.
    """
    suffix = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    return _DOC_SUFFIX_FORMATS.get(suffix, "txt")


_TEXT_SNIFF_BYTES = 8192


def is_text_payload(payload: bytes) -> bool:
    """Decide if a byte payload should be treated as editable text.

    Inspects only the first 8KB: a null byte means binary; otherwise the
    prefix must decode as strict UTF-8. Uses strict decode (no errors=
    "ignore"/"replace") so binary files are never silently coerced into docs.
    """
    head = payload[:_TEXT_SNIFF_BYTES]
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
    except UnicodeDecodeError:
        # A truncated multibyte sequence at the 8KB boundary is a false
        # negative; acceptable since real text files rarely split exactly there.
        return False
    return True


SKILL_DATA_FOLDER_NAME = "_skill_data"


class DocVersionConflictError(Exception):
    def __init__(self, current: Doc) -> None:
        self.current = current
        super().__init__("document version conflict")


class ProjectFsService:
    def __init__(self, db: Session, project: Project) -> None:
        self.db = db
        self.project = project

    def _get_folder_in_project(self, folder_id: str | None) -> Folder | None:
        if not folder_id:
            return None
        folder = self.db.get(Folder, folder_id)
        if folder is None or folder.project_id != self.project.id:
            return None
        return folder

    def _get_doc_in_project(self, doc_id: str) -> Doc | None:
        doc = self.db.get(Doc, doc_id)
        if doc is None or doc.project_id != self.project.id:
            return None
        return doc

    def _get_file_in_project(self, file_id: str) -> FileBlob | None:
        file = self.db.get(FileBlob, file_id)
        if file is None or file.project_id != self.project.id:
            return None
        return file

    def _get_entity_in_project(
        self,
        entity_type: str,
        entity_id: str,
    ) -> Folder | Doc | FileBlob | None:
        if entity_type == "folder":
            return self._get_folder_in_project(entity_id)
        if entity_type == "doc":
            return self._get_doc_in_project(entity_id)
        if entity_type == "file":
            return self._get_file_in_project(entity_id)
        return None

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
            .options(
                load_only(
                    FileBlob.id,
                    FileBlob.folder_id,
                    FileBlob.name,
                    FileBlob.mime_type,
                    FileBlob.size_bytes,
                    FileBlob.updated_at,
                )
            )
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

        def build_folder_node(
            folder_id: str | None,
            name: str,
            is_virtual_root: bool = False,
        ) -> TreeFolderOut:
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
        name = validate_project_entry_name(name)
        if parent_folder_id and self._get_folder_in_project(parent_folder_id) is None:
            raise ValueError("parent folder not found")

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
        name = validate_project_entry_name(name)
        if folder_id and self._get_folder_in_project(folder_id) is None:
            raise ValueError("folder not found")

        existing = self._find_doc_by_name(folder_id, name)
        if existing is not None:
            existing.format = format
            existing.content = content
            existing.version += 1
            existing.updated_at = datetime.utcnow()
            self._delete_file_siblings(folder_id, name)
            self.db.commit()
            self.db.refresh(existing)
            return existing

        self._delete_file_siblings(folder_id, name)
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
        return self._get_doc_in_project(doc_id)

    def update_doc_content(
        self,
        doc_id: str,
        content: str,
        *,
        origin: str = "auto_save",
        actor: str | None = None,
        expected_version: int | None = None,
    ) -> Doc | None:
        doc = self._get_doc_in_project(doc_id)
        if doc is None:
            return None
        if expected_version is not None and doc.version != expected_version:
            raise DocVersionConflictError(doc)
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
        new_name = validate_project_entry_name(new_name)
        entity = self._get_entity_in_project(entity_type, entity_id)
        if entity is None:
            return False
        entity.name = new_name  # type: ignore[union-attr]
        entity.updated_at = datetime.utcnow()  # type: ignore[union-attr]
        if entity_type == "doc":
            entity.format = doc_format_for_name(new_name)  # type: ignore[union-attr]
            self._delete_doc_siblings(entity.folder_id, new_name, keep_id=entity.id)  # type: ignore[union-attr]
            self._delete_file_siblings(entity.folder_id, new_name)  # type: ignore[union-attr]
        elif entity_type == "file":
            self._delete_file_siblings(entity.folder_id, new_name, keep_id=entity.id)  # type: ignore[union-attr]
            self._delete_doc_siblings(entity.folder_id, new_name)  # type: ignore[union-attr]
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
            self._delete_doc_siblings(target_folder_id, doc.name, keep_id=doc.id)
            self._delete_file_siblings(target_folder_id, doc.name)
        elif entity_type == "file":
            f = self.db.get(FileBlob, entity_id)
            if f is None or f.project_id != project.id:
                return False, "file not found"
            f.folder_id = target_folder_id
            f.updated_at = datetime.utcnow()
            self._delete_file_siblings(target_folder_id, f.name, keep_id=f.id)
            self._delete_doc_siblings(target_folder_id, f.name)
        else:
            return False, "invalid entity type"

        self.db.commit()
        return True, None

    def delete_entity(self, entity_type: str, entity_id: str) -> int:
        """Delete an entity and return the count of deleted rows (recursive for folders)."""
        if entity_type == "folder":
            return self._delete_folder_recursive(entity_id)
        entity = self._get_entity_in_project(entity_type, entity_id)
        if entity is None:
            return 0
        self.db.delete(entity)
        self.db.commit()
        return 1

    def _delete_folder_recursive(self, folder_id: str) -> int:
        folder = self._get_folder_in_project(folder_id)
        if folder is None:
            return 0
        count = 0
        for child in (
            self.db.query(Folder)
            .filter(Folder.project_id == self.project.id, Folder.parent_folder_id == folder_id)
            .all()
        ):
            count += self._delete_folder_recursive(child.id)
        count += (
            self.db.query(Doc)
            .filter(Doc.project_id == self.project.id, Doc.folder_id == folder_id)
            .delete()
        )
        count += (
            self.db.query(FileBlob)
            .filter(FileBlob.project_id == self.project.id, FileBlob.folder_id == folder_id)
            .delete()
        )
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
        name = validate_project_entry_name(name)
        if folder_id and self._get_folder_in_project(folder_id) is None:
            raise ValueError("folder not found")
        existing = self._find_file_by_name(folder_id, name)
        if existing is not None:
            existing.mime_type = mime_type
            existing.size_bytes = len(blob)
            existing.blob = blob
            existing.updated_at = datetime.utcnow()
            self._delete_doc_siblings(folder_id, name)
            self.db.commit()
            self.db.refresh(existing)
            return existing

        self._delete_doc_siblings(folder_id, name)
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

    def _find_doc_by_name(self, folder_id: str | None, name: str) -> Doc | None:
        return (
            self.db.query(Doc)
            .filter(
                Doc.project_id == self.project.id,
                Doc.folder_id == folder_id,
                Doc.name == name,
            )
            .first()
        )

    def _find_file_by_name(self, folder_id: str | None, name: str) -> FileBlob | None:
        return (
            self.db.query(FileBlob)
            .filter(
                FileBlob.project_id == self.project.id,
                FileBlob.folder_id == folder_id,
                FileBlob.name == name,
            )
            .first()
        )

    def _delete_doc_siblings(
        self,
        folder_id: str | None,
        name: str,
        *,
        keep_id: str | None = None,
    ) -> int:
        query = self.db.query(Doc).filter(
            Doc.project_id == self.project.id,
            Doc.folder_id == folder_id,
            Doc.name == name,
        )
        if keep_id is not None:
            query = query.filter(Doc.id != keep_id)
        deleted_docs = query.all()
        for doc in deleted_docs:
            if self.project.main_doc_id == doc.id:
                self.project.main_doc_id = ""
            self.db.delete(doc)
        return len(deleted_docs)

    def _delete_file_siblings(
        self,
        folder_id: str | None,
        name: str,
        *,
        keep_id: str | None = None,
    ) -> int:
        query = self.db.query(FileBlob).filter(
            FileBlob.project_id == self.project.id,
            FileBlob.folder_id == folder_id,
            FileBlob.name == name,
        )
        if keep_id is not None:
            query = query.filter(FileBlob.id != keep_id)
        deleted_files = query.all()
        for file in deleted_files:
            self.db.delete(file)
        return len(deleted_files)

    # --------------------------------------------------------- import directory

    def replace_from_zip(self, blob: bytes) -> tuple[int, int, int]:
        """Replace this project's tree with the contents of a ZIP archive."""
        if len(blob) > _MAX_ZIP_UPLOAD_BYTES:
            raise ValueError("zip archive is too large")

        try:
            archive = zipfile.ZipFile(io.BytesIO(blob))
        except zipfile.BadZipFile as e:
            raise ValueError("invalid zip archive") from e

        with archive:
            infos = [info for info in archive.infolist() if not info.is_dir()]
            if not infos:
                raise ValueError("zip archive is empty")
            if len(infos) > _MAX_ZIP_ENTRIES:
                raise ValueError("zip archive contains too many files")

            expanded_size = sum(max(info.file_size, 0) for info in infos)
            if expanded_size > _MAX_ZIP_EXPANDED_BYTES:
                raise ValueError("zip archive expands to too much data")

            with tempfile.TemporaryDirectory(prefix="ylw-zip-import-") as tmp:
                root = Path(tmp)
                extracted = 0
                for info in infos:
                    rel_path = _safe_zip_member_path(info.filename)
                    if rel_path is None or _is_ignored_zip_member(rel_path):
                        continue
                    if _is_zip_symlink(info):
                        continue
                    target = root / rel_path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as src, target.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
                    extracted += 1

                if extracted == 0:
                    raise ValueError("zip archive does not contain importable files")
                return self.replace_from_directory(root)

    def replace_from_directory(self, root: Path) -> tuple[int, int, int]:
        """Replace this project's tree with files from a local directory."""
        if not root.exists() or not root.is_dir():
            raise ValueError("import root not found")

        importable_paths: list[Path] = []
        for file_path in sorted(root.rglob("*")):
            if not file_path.is_file():
                continue
            rel = file_path.relative_to(root)
            if ".git" in rel.parts:
                continue
            for part in rel.parts:
                validate_project_entry_name(part, field="import entry name")
            importable_paths.append(file_path)

        self.db.query(Doc).filter(Doc.project_id == self.project.id).delete(
            synchronize_session=False
        )
        self.db.query(FileBlob).filter(FileBlob.project_id == self.project.id).delete(
            synchronize_session=False
        )
        self.db.query(Folder).filter(Folder.project_id == self.project.id).delete(
            synchronize_session=False
        )
        self.db.flush()

        folder_cache: dict[Path, Folder | None] = {Path("."): None}

        def ensure_folder(rel_dir: Path) -> Folder | None:
            if rel_dir in folder_cache:
                return folder_cache[rel_dir]
            parent = ensure_folder(rel_dir.parent)
            folder = Folder(
                project_id=self.project.id,
                parent_folder_id=parent.id if parent else None,
                name=rel_dir.name,
            )
            self.db.add(folder)
            self.db.flush()
            folder_cache[rel_dir] = folder
            return folder

        doc_count = 0
        file_count = 0
        byte_count = 0
        for file_path in importable_paths:
            rel = file_path.relative_to(root)
            payload = file_path.read_bytes()
            byte_count += len(payload)
            parent = ensure_folder(rel.parent)
            suffix = file_path.suffix.lower()
            doc_format = _doc_format(suffix)
            if doc_format is not None:
                try:
                    content = payload.decode("utf-8")
                except UnicodeDecodeError:
                    content = payload.decode("utf-8", errors="replace")
                self.db.add(
                    Doc(
                        project_id=self.project.id,
                        folder_id=parent.id if parent else None,
                        name=rel.name,
                        format=doc_format,
                        content=content,
                        version=1,
                    )
                )
                doc_count += 1
            else:
                mime_type = mimetypes.guess_type(rel.name)[0] or "application/octet-stream"
                self.db.add(
                    FileBlob(
                        project_id=self.project.id,
                        folder_id=parent.id if parent else None,
                        name=rel.name,
                        mime_type=mime_type,
                        size_bytes=len(payload),
                        blob=payload,
                    )
                )
                file_count += 1

        self.db.flush()
        main_doc = (
            self.db.query(Doc)
            .filter(
                Doc.project_id == self.project.id,
                Doc.folder_id.is_(None),
                Doc.name == "main.tex",
            )
            .first()
        )
        if main_doc is None:
            main_doc = (
                self.db.query(Doc)
                .filter(
                    Doc.project_id == self.project.id,
                    Doc.folder_id.is_(None),
                    Doc.format == "tex",
                )
                .order_by(Doc.name.asc())
                .first()
            )
        if main_doc is None:
            main_doc = (
                self.db.query(Doc)
                .filter(Doc.project_id == self.project.id, Doc.format == "tex")
                .order_by(Doc.name.asc())
                .first()
            )
        self.project.main_doc_id = main_doc.id if main_doc is not None else ""
        self.project.updated_at = datetime.utcnow()
        self.db.commit()
        return doc_count, file_count, byte_count

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
            folder_paths[f.id] = validate_project_entry_name(f.name, field="folder name")

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
                name = validate_project_entry_name(d.name, field="document name")
                path = f"{prefix}/{name}" if prefix else name
                if _is_ignored_project_artifact_path(PurePosixPath(path), project=project):
                    continue
                zf.writestr(path, d.content or "")
            for f in files:
                prefix = resolve_path(f.folder_id)
                name = validate_project_entry_name(f.name, field="file name")
                path = f"{prefix}/{name}" if prefix else name
                if _is_ignored_project_artifact_path(PurePosixPath(path), project=project):
                    continue
                zf.writestr(path, f.blob or b"")

        return buf.getvalue()

    def materialize_to_directory(self, root: Path) -> tuple[int, int, int]:
        """Write the current SQLite-backed project tree into a real folder."""
        root.mkdir(parents=True, exist_ok=True)
        for child in root.iterdir():
            if child.name == ".git":
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()

        folders = self.db.query(Folder).filter(Folder.project_id == self.project.id).all()
        docs = self.db.query(Doc).filter(Doc.project_id == self.project.id).all()
        files = self.db.query(FileBlob).filter(FileBlob.project_id == self.project.id).all()
        folder_by_id = {folder.id: folder for folder in folders}

        def folder_parts(folder_id: str | None) -> list[str]:
            parts: list[str] = []
            seen: set[str] = set()
            current = folder_id
            while current and current not in seen:
                seen.add(current)
                folder = folder_by_id.get(current)
                if folder is None:
                    break
                parts.append(validate_project_entry_name(folder.name, field="folder name"))
                current = folder.parent_folder_id
            parts.reverse()
            return parts

        doc_count = 0
        file_count = 0
        byte_count = 0
        for doc in docs:
            rel = Path(
                *folder_parts(doc.folder_id),
                validate_project_entry_name(doc.name, field="document name"),
            )
            if _is_ignored_materialized_path(rel, project=self.project):
                continue
            payload = (doc.content or "").encode("utf-8")
            _write_file(root / rel, payload)
            doc_count += 1
            byte_count += len(payload)

        for file in files:
            rel = Path(
                *folder_parts(file.folder_id),
                validate_project_entry_name(file.name, field="file name"),
            )
            if _is_ignored_materialized_path(rel, project=self.project):
                continue
            payload = file.blob or b""
            _write_file(root / rel, payload)
            file_count += 1
            byte_count += len(payload)

        return doc_count, file_count, byte_count


def _doc_format(suffix: str) -> str | None:
    return _DOC_SUFFIX_FORMATS.get(suffix)


def _safe_zip_member_path(name: str) -> Path | None:
    if "\\" in name:
        raise ValueError("zip archive contains an unsafe path")
    normalized = name
    if not normalized:
        return None
    path = PurePosixPath(normalized)
    if path.is_absolute():
        raise ValueError("zip archive contains an absolute path")
    parts = path.parts
    if not parts:
        return None
    for part in parts:
        if part in {"", ".", ".."} or "\x00" in part:
            raise ValueError("zip archive contains an unsafe path")
        validate_project_entry_name(part, field="zip entry name")
    return Path(*parts)


def _is_ignored_zip_member(path: Path) -> bool:
    parts = path.parts
    return (
        "__MACOSX" in parts
        or ".git" in parts
        or path.name in {".DS_Store", "Thumbs.db"}
    )


def _is_zip_symlink(info: zipfile.ZipInfo) -> bool:
    mode = info.external_attr >> 16
    return stat.S_ISLNK(mode)


def _safe_name(name: str) -> str:
    cleaned = "".join("_" if ch in '/\\:\0' else ch for ch in name).strip()
    if cleaned in {"", ".", ".."}:
        return "untitled"
    return cleaned or "untitled"


def _is_ignored_materialized_path(path: Path, *, project: Project) -> bool:
    return _is_ignored_project_artifact_path(path, project=project)


def _is_ignored_project_artifact_path(path: Path | PurePosixPath, *, project: Project) -> bool:
    parts = path.parts
    return ".git" in parts or (
        (project.project_type == "skill" or project.is_skill_project)
        and bool(parts)
        and parts[0] == SKILL_DATA_FOLDER_NAME
    )


def _write_file(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)

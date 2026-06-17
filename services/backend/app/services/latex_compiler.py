"""LaTeX compiler service.

Detects system LaTeX compilers (TeX Live / MacTeX), reconstructs the project
tree in a temporary directory, runs the compiler, and caches the resulting PDF
in memory.

Design:
- Compiler detection runs once at service construction and is cached.
- Each compile creates a fresh temp directory, writes all docs + file blobs,
  then runs `latexmk` (preferred) or the selected compiler directly.
- For `latexmk` we let it figure out how many runs to do (handles bibtex,
  multi-pass references, etc.). For direct compilers we do a simple 2-pass
  run to resolve references.
- Results live in `_pdf_cache: dict[project_id, CompileResult]`. Keyed by
  project so the same cache entry is bumped whenever any doc in the project
  is recompiled.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import posixpath
import re
import resource
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path

from sqlalchemy.orm import Session, load_only

from ..models import Doc, FileBlob, Folder, Project
from ..settings import settings
from .project_entry_name import ProjectEntryNameError, validate_project_entry_name

# All known TeX Live / MacTeX binaries we'll try to detect.
KNOWN_COMPILERS = ("latexmk", "pdflatex", "xelatex", "lualatex")
COMPILER_CONTROL_FILENAMES = frozenset(
    {
        ".latexmkrc",
        "latexmkrc",
        ".texmf.cnf",
        "texmf.cnf",
    }
)
TEX_FILE_ACCESS_POLICY = "p"
DIRECT_COMPILER_SECURITY_ARGS = ("-no-shell-escape",)
COMPILE_CPU_LIMIT_SECONDS = 130
COMPILE_FILE_SIZE_LIMIT_BYTES = 256 * 1024 * 1024
COMPILE_ADDRESS_SPACE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
COMPILE_PROCESS_LIMIT = 256
GRAPHICS_EXTENSIONS = (".pdf", ".png", ".jpg", ".jpeg", ".eps")
INCLUDEGRAPHICS_RE = re.compile(
    r"(?P<command>\\includegraphics(?:\s*\[[^\]]*\])?\s*)\{(?P<target>[^{}]+)\}"
)
GRAPHICSPATH_RE = re.compile(r"\\graphicspath\s*\{(?P<body>(?:\{[^{}]*\}\s*)+)\}")
GRAPHICSPATH_ENTRY_RE = re.compile(r"\{(?P<path>[^{}]*)\}")
INCREMENTAL_CACHE_DIR_NAME = "latex-incremental-cache"
SYNC_STATE_FILE = ".project-sync-state"
OUTPUT_BUILD_DIR_NAME = "latex-output-builds"
MAX_OUTPUT_BUILDS_PER_PROJECT = 2
FINAL_OUTPUT_NAMES = frozenset(
    {
        "output.pdf",
        "output.log",
        "output.synctex.gz",
        "output.dvi",
        "output.xdv",
        "output.aux",
        "output.fls",
        "output.fdb_latexmk",
        "output.stdout",
        "output.stderr",
        "output.tar.gz",
    }
)
PRESERVED_GENERATED_PATTERNS = (
    "*.aux",
    "*.fls",
    "*.fdb_latexmk",
    "*.pygtex",
    "*.pygstyle",
)
CONTENT_BEARING_GENERATED_SUFFIXES = frozenset(
    {
        ".bbl",
        ".bcf",
        ".blg",
        ".idx",
        ".ind",
        ".toc",
        ".out",
    }
)


@dataclass
class CompileResult:
    ok: bool
    pdf: bytes | None
    synctex: bytes | None
    log: str
    error: str
    compiler: str
    duration_ms: int
    status: str = "failure"
    build_id: str = ""
    source_paths: dict[str, str] = field(default_factory=dict)
    main_rel_path: str = ""
    started_at: float = field(default_factory=time.time)


@dataclass(frozen=True)
class ProjectTreeWriteResult:
    main_rel_path: Path
    warnings: list[str]
    source_paths: dict[str, str]
    workspace_manifest: set[str]

    def __iter__(self):
        yield self.main_rel_path
        yield self.warnings
        yield self.source_paths


class LatexCompilerService:
    """Stateful service. One instance per process — holds the PDF cache."""

    def __init__(self) -> None:
        self._available_compilers = self._detect_compilers()
        # project_id -> CompileResult
        self._pdf_cache: dict[str, CompileResult] = {}
        self._active_compile_keys: set[str] = set()
        self._active_compile_guard = asyncio.Lock()
        self._active_compile_count = 0
        self._global_compile_limit = max(1, int(os.environ.get("YLW_COMPILE_CONCURRENCY", "2")))
        self._last_compile_started_at: dict[str, float] = {}
        self._manual_cooldown_seconds = 1.0
        self._auto_cooldown_seconds = 2.5

    # ----------------------------------------------------------- detection

    @staticmethod
    def _detect_compilers() -> list[str]:
        """Return the subset of KNOWN_COMPILERS that are on PATH."""
        found: list[str] = []
        for name in KNOWN_COMPILERS:
            if shutil.which(name):
                found.append(name)
        return found

    @property
    def available_compilers(self) -> list[str]:
        return list(self._available_compilers)

    def rescan_compilers(self) -> list[str]:
        """Re-run detection. Useful if the user installed LaTeX after startup."""
        self._available_compilers = self._detect_compilers()
        return self.available_compilers

    # ----------------------------------------------------------- cache

    def get_cached(self, project_id: str) -> CompileResult | None:
        return self._pdf_cache.get(project_id)

    def clear_cache(self, project_id: str | None = None) -> None:
        if project_id is None:
            self._pdf_cache.clear()
            shutil.rmtree(settings.data_dir / INCREMENTAL_CACHE_DIR_NAME, ignore_errors=True)
            shutil.rmtree(settings.data_dir / OUTPUT_BUILD_DIR_NAME, ignore_errors=True)
            return

        self._pdf_cache.pop(project_id, None)
        workspace_key = self._workspace_key(project_id)
        self._clear_project_cache_dir(INCREMENTAL_CACHE_DIR_NAME, workspace_key)
        self._clear_project_cache_dir(OUTPUT_BUILD_DIR_NAME, workspace_key)

    def _project_cache_dir(self, root_name: str, workspace_key: str, *, create: bool) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9_.:-]+", workspace_key):
            raise ValueError("incremental compile cache path escaped cache root")
        root = settings.data_dir / root_name
        if create:
            root.mkdir(parents=True, exist_ok=True)
            try:
                root.chmod(0o700)
            except OSError:
                pass
        project_dir = root / workspace_key
        resolved_root = root.resolve(strict=False)
        resolved_project_dir = project_dir.resolve(strict=False)
        if resolved_project_dir != resolved_root and not str(resolved_project_dir).startswith(
            f"{resolved_root}{os.sep}"
        ):
            raise ValueError("incremental compile cache path escaped cache root")
        if create:
            project_dir.mkdir(parents=True, exist_ok=True)
        return project_dir

    def _incremental_project_dir(self, workspace_key: str) -> Path:
        return self._project_cache_dir(INCREMENTAL_CACHE_DIR_NAME, workspace_key, create=True)

    def _output_project_dir(self, workspace_key: str) -> Path:
        return self._project_cache_dir(OUTPUT_BUILD_DIR_NAME, workspace_key, create=True)

    def _clear_project_cache_dir(self, root_name: str, workspace_key: str) -> None:
        project_dir = self._project_cache_dir(root_name, workspace_key, create=False)
        shutil.rmtree(project_dir, ignore_errors=True)

    def _workspace_key(self, project_id: str) -> str:
        return project_id

    # ----------------------------------------------------------- sync state

    def _compute_compile_sync_state(
        self,
        db: Session,
        project_id: str,
        *,
        main_doc_id: str | None,
        compiler: str,
    ) -> str:
        docs = (
            db.query(Doc)
            .options(load_only(Doc.id, Doc.folder_id, Doc.name, Doc.format, Doc.version, Doc.updated_at))
            .filter(Doc.project_id == project_id)
            .all()
        )
        files = (
            db.query(FileBlob)
            .options(load_only(FileBlob.id, FileBlob.folder_id, FileBlob.name, FileBlob.size_bytes, FileBlob.updated_at))
            .filter(FileBlob.project_id == project_id)
            .all()
        )
        folders = (
            db.query(Folder)
            .options(load_only(Folder.id, Folder.parent_folder_id, Folder.name, Folder.updated_at))
            .filter(Folder.project_id == project_id)
            .all()
        )
        payload = {
            "compiler": compiler,
            "main_doc_id": main_doc_id or "",
            "folders": sorted(
                f"{f.id}:{f.parent_folder_id or ''}:{f.name}:{f.updated_at.isoformat() if f.updated_at else ''}"
                for f in folders
            ),
            "docs": sorted(
                f"{d.id}:{d.folder_id or ''}:{d.name}:{d.format}:{d.version}:{d.updated_at.isoformat() if d.updated_at else ''}"
                for d in docs
            ),
            "files": sorted(
                f"{f.id}:{f.folder_id or ''}:{f.name}:{f.size_bytes}:{f.updated_at.isoformat() if f.updated_at else ''}"
                for f in files
            ),
        }
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def _read_workspace_sync_state(self, workspace: Path) -> str | None:
        state_path = workspace / SYNC_STATE_FILE
        try:
            lines = state_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return None
        if not lines:
            return None
        marker = lines[-1]
        prefix = "stateHash:"
        if not marker.startswith(prefix):
            return None
        return marker.removeprefix(prefix) or None

    def _write_workspace_sync_state(
        self,
        workspace: Path,
        sync_state: str,
        workspace_manifest: set[str],
    ) -> None:
        resource_list = sorted(workspace_manifest)
        payload = "\n".join(["manifestVersion:2", *resource_list, f"stateHash:{sync_state}", ""])
        (workspace / SYNC_STATE_FILE).write_text(payload, encoding="utf-8")

    # ----------------------------------------------------------- workspace writers

    def _write_full_compile_workspace(
        self,
        db: Session,
        project_id: str,
        workspace: Path,
        main_doc: Doc,
    ) -> ProjectTreeWriteResult:
        self._remove_stale_final_outputs(workspace)
        tree = self._write_project_tree(
            db,
            project_id,
            workspace,
            main_doc,
        )
        expected_sources = self._expected_workspace_source_files(
            workspace,
            tree.workspace_manifest,
        )
        for stale in sorted((path for path in workspace.rglob("*") if path.is_file())):
            if stale.name == SYNC_STATE_FILE:
                continue
            if stale.resolve(strict=False) in expected_sources:
                continue
            if self._should_preserve_generated_cache(stale, workspace):
                continue
            stale.unlink(missing_ok=True)
        self._prune_empty_dirs(workspace)
        return tree

    def _expected_workspace_source_files(
        self,
        workspace: Path,
        workspace_manifest: set[str],
    ) -> set[Path]:
        resolved_workspace = workspace.resolve(strict=False)
        expected: set[Path] = set()
        for rel_path in workspace_manifest:
            candidate = (workspace / rel_path).resolve(strict=False)
            if candidate != resolved_workspace and not str(candidate).startswith(
                f"{resolved_workspace}{os.sep}"
            ):
                raise ValueError("project source path escaped compile workspace")
            expected.add(candidate)
        return expected

    def _remove_stale_final_outputs(self, workspace: Path) -> None:
        for path in workspace.rglob("*"):
            if path.is_file() and path.name in FINAL_OUTPUT_NAMES:
                path.unlink(missing_ok=True)

    def _should_preserve_generated_cache(self, path: Path, workspace: Path) -> bool:
        if path.suffix.lower() in CONTENT_BEARING_GENERATED_SUFFIXES:
            return False
        rel = path.relative_to(workspace).as_posix()
        for pattern in PRESERVED_GENERATED_PATTERNS:
            if fnmatch(path.name, pattern) or fnmatch(rel, pattern):
                return True
        return False

    def _prune_empty_dirs(self, root: Path) -> None:
        for path in sorted(root.rglob("*"), key=lambda value: len(value.parts), reverse=True):
            if path.is_dir():
                try:
                    path.rmdir()
                except OSError:
                    pass

    def _write_incremental_compile_workspace(
        self,
        db: Session,
        project_id: str,
        workspace: Path,
        main_doc: Doc,
    ) -> ProjectTreeWriteResult:
        tree = self._write_project_tree(
            db,
            project_id,
            workspace,
            main_doc,
        )
        self._remove_stale_final_outputs(workspace)
        return tree

    # ----------------------------------------------------------- compile guards

    def _status_result(self, status: str, message: str, compiler: str = "") -> CompileResult:
        return CompileResult(
            ok=False,
            status=status,
            build_id="",
            pdf=None,
            synctex=None,
            log="",
            error=message,
            compiler=compiler,
            duration_ms=0,
        )

    def _check_compile_cooldown(
        self,
        workspace_key: str,
        now: float,
        *,
        is_auto_compile: bool,
    ) -> CompileResult | None:
        last_started = self._last_compile_started_at.get(workspace_key, 0.0)
        cooldown_seconds = self._auto_cooldown_seconds if is_auto_compile else self._manual_cooldown_seconds
        if now - last_started >= cooldown_seconds:
            return None
        status = "autocompile-backoff" if is_auto_compile else "too-recently-compiled"
        message = "自动编译过于频繁，已暂停。" if is_auto_compile else "编译请求过于频繁，请稍后再试。"
        return self._status_result(status, message)

    async def _try_begin_compile(self, workspace_key: str) -> bool:
        async with self._active_compile_guard:
            if workspace_key in self._active_compile_keys:
                return False
            if self._active_compile_count >= self._global_compile_limit:
                return False
            self._active_compile_keys.add(workspace_key)
            self._active_compile_count += 1
            return True

    async def _end_compile(self, workspace_key: str) -> None:
        async with self._active_compile_guard:
            self._active_compile_keys.discard(workspace_key)
            self._active_compile_count = max(0, self._active_compile_count - 1)

    # ----------------------------------------------------------- compile

    async def compile_project(
        self,
        db: Session,
        project_id: str,
        *,
        main_doc_id: str | None = None,
        compiler: str | None = None,
        incremental: bool = False,
        from_scratch: bool = False,
        is_auto_compile: bool = False,
    ) -> CompileResult:
        """Compile the project with lock/cooldown guards."""
        started = time.time()
        workspace_key = self._workspace_key(project_id)
        chosen_compiler = compiler or (self._default_compiler() if self._available_compilers else "")

        # Check lock first — concurrent calls should see compile-in-progress,
        # not too-recently-compiled.
        if not await self._try_begin_compile(workspace_key):
            return self._status_result(
                "compile-in-progress",
                "已有编译正在进行，请稍后再试。",
                chosen_compiler,
            )

        cooldown = self._check_compile_cooldown(
            workspace_key,
            started,
            is_auto_compile=is_auto_compile,
        )
        if cooldown is not None:
            await self._end_compile(workspace_key)
            return cooldown

        try:
            self._last_compile_started_at[workspace_key] = started
            return await self._compile_project_unlocked(
                db,
                project_id,
                main_doc_id=main_doc_id,
                compiler=compiler,
                incremental=incremental,
                from_scratch=from_scratch,
                is_auto_compile=is_auto_compile,
                started=started,
            )
        finally:
            await self._end_compile(workspace_key)

    async def _compile_project_unlocked(
        self,
        db: Session,
        project_id: str,
        *,
        main_doc_id: str | None,
        compiler: str | None,
        incremental: bool,
        from_scratch: bool,
        is_auto_compile: bool,
        started: float,
    ) -> CompileResult:
        """Actual compile logic, called under lock."""
        del is_auto_compile

        if not self._available_compilers:
            result = CompileResult(
                ok=False,
                pdf=None,
                synctex=None,
                log="",
                error="未检测到 LaTeX 编译器。请安装 MacTeX 或 TeX Live。",
                compiler="",
                duration_ms=0,
            )
            self._pdf_cache[project_id] = result
            return result

        chosen_compiler = compiler or self._default_compiler()
        if chosen_compiler not in self._available_compilers:
            result = CompileResult(
                ok=False,
                pdf=None,
                synctex=None,
                log="",
                error=f"请求的编译器 {chosen_compiler} 在系统上不可用。",
                compiler=chosen_compiler,
                duration_ms=0,
            )
            self._pdf_cache[project_id] = result
            return result

        project = db.get(Project, project_id)
        if project is None:
            raise ValueError(f"project {project_id} not found")

        # Find the main doc.
        main_doc = self._resolve_main_doc(db, project_id, main_doc_id)
        if main_doc is None:
            result = CompileResult(
                ok=False,
                pdf=None,
                synctex=None,
                log="",
                error="项目中找不到可编译的 .tex 文件。",
                compiler=chosen_compiler,
                duration_ms=int((time.time() - started) * 1000),
            )
            self._pdf_cache[project_id] = result
            return result

        # Write project tree and compile.
        workspace_key = self._workspace_key(project_id)
        sync_state = self._compute_compile_sync_state(
            db,
            project_id,
            main_doc_id=main_doc.id,
            compiler=chosen_compiler,
        )

        if from_scratch:
            self.clear_cache(project_id)

        try:
            if incremental:
                workspace = self._incremental_project_dir(workspace_key)
                previous_state = None if from_scratch else self._read_workspace_sync_state(workspace)
                if previous_state == sync_state:
                    tree = self._write_incremental_compile_workspace(
                        db, project_id, workspace, main_doc,
                    )
                else:
                    tree = self._write_full_compile_workspace(
                        db, project_id, workspace, main_doc,
                    )
                    self._write_workspace_sync_state(
                        workspace,
                        sync_state,
                        tree.workspace_manifest,
                    )
                main_rel_path = tree.main_rel_path
                placeholder_warnings = tree.warnings
                source_paths = tree.source_paths
                result = await self._run_compiler(
                    tmpdir=workspace,
                    main_rel_path=main_rel_path,
                    compiler=chosen_compiler,
                    source_paths=source_paths,
                    output_dir=workspace,
                )
            else:
                with tempfile.TemporaryDirectory(prefix="ylw-tex-") as tmp:
                    tmpdir = Path(tmp)
                    tree = self._write_project_tree(db, project_id, tmpdir, main_doc)
                    main_rel_path = tree.main_rel_path
                    placeholder_warnings = tree.warnings
                    source_paths = tree.source_paths
                    result = await self._run_compiler(
                        tmpdir=tmpdir,
                        main_rel_path=main_rel_path,
                        compiler=chosen_compiler,
                        source_paths=source_paths,
                    )
        except ProjectEntryNameError as exc:
            result = CompileResult(
                ok=False,
                pdf=None,
                synctex=None,
                log="",
                error=str(exc),
                compiler=chosen_compiler,
                duration_ms=int((time.time() - started) * 1000),
            )
            self._pdf_cache[project_id] = result
            return result

        result.duration_ms = int((time.time() - started) * 1000)
        if result.ok:
            result.status = "success"
            if not result.build_id:
                result.build_id = self._new_build_id()
        if placeholder_warnings:
            warning_log = "\n".join(
                ["", "SuperLeaf missing-graphics placeholders:"]
                + [f"- {w}" for w in placeholder_warnings]
            )
            result.log = (result.log + warning_log)[-20000:]
        self._pdf_cache[project_id] = result
        return result

    def _new_build_id(self) -> str:
        return f"{int(time.time() * 1000):x}-{os.urandom(8).hex()}"

    def _default_compiler(self) -> str:
        if "latexmk" in self._available_compilers:
            return "latexmk"
        return self._available_compilers[0]

    def _resolve_main_doc(
        self, db: Session, project_id: str, main_doc_id: str | None
    ) -> Doc | None:
        if main_doc_id:
            doc = db.get(Doc, main_doc_id)
            if doc and doc.project_id == project_id and doc.format == "tex":
                return doc

        # Heuristics: main.tex at project root, else first .tex at root, else
        # first .tex anywhere.
        tex_docs = (
            db.query(Doc)
            .filter(Doc.project_id == project_id, Doc.format == "tex")
            .all()
        )
        if not tex_docs:
            return None

        root_docs = [d for d in tex_docs if d.folder_id is None]
        for d in root_docs:
            if d.name.lower() == "main.tex":
                return d
        if root_docs:
            return root_docs[0]
        return tex_docs[0]

    def _write_project_tree(
        self, db: Session, project_id: str, tmpdir: Path, main_doc: Doc
    ) -> ProjectTreeWriteResult:
        """Write all docs + files of the project into tmpdir, preserving folder
        structure. Returns the relative path of the main doc within tmpdir."""

        folders = db.query(Folder).filter(Folder.project_id == project_id).all()
        docs = db.query(Doc).filter(Doc.project_id == project_id).all()
        file_metadata = (
            db.query(FileBlob)
            .options(
                load_only(
                    FileBlob.id,
                    FileBlob.folder_id,
                    FileBlob.name,
                )
            )
            .filter(FileBlob.project_id == project_id)
            .all()
        )
        for folder in folders:
            _validate_compile_entry_name(folder.name, field="folder name")
        for doc in docs:
            _validate_compile_entry_name(doc.name, field="document name")
        for file in file_metadata:
            _validate_compile_entry_name(file.name, field="file name")
        _validate_compile_entry_name(main_doc.name, field="document name")

        folder_paths: dict[str, Path] = {}

        def resolve_folder_path(folder_id: str | None) -> Path:
            if folder_id is None:
                return tmpdir
            if folder_id in folder_paths:
                return folder_paths[folder_id]
            folder = next((f for f in folders if f.id == folder_id), None)
            if folder is None:
                return tmpdir
            parent_path = resolve_folder_path(folder.parent_folder_id)
            path = parent_path / folder.name
            folder_paths[folder_id] = path
            return path

        # Make all folder paths.
        for f in folders:
            resolve_folder_path(f.id)
        for path in folder_paths.values():
            path.mkdir(parents=True, exist_ok=True)

        existing_paths: set[str] = set()

        def add_existing(path: Path) -> None:
            existing_paths.add(posixpath.normpath(path.as_posix().lstrip("/")))

        for d in docs:
            add_existing((resolve_folder_path(d.folder_id) / d.name).relative_to(tmpdir))
        for f in file_metadata:
            add_existing((resolve_folder_path(f.folder_id) / f.name).relative_to(tmpdir))

        placeholder_warnings: list[str] = []
        project_manifest: set[str] = set()

        def add_manifest_path(path: Path) -> None:
            project_manifest.add(self._workspace_manifest_path(path.relative_to(tmpdir)))

        # Write all docs (text).
        main_rel_path = Path(main_doc.name)
        doc_rel_paths: dict[str, Path] = {}
        for d in docs:
            folder_path = resolve_folder_path(d.folder_id)
            file_path = folder_path / d.name
            file_path.parent.mkdir(parents=True, exist_ok=True)
            content = d.content or ""
            if d.format == "tex":
                content = self._replace_missing_graphics(
                    content,
                    doc_rel_dir=folder_path.relative_to(tmpdir),
                    project_rel_dir=Path("."),
                    existing_paths=existing_paths,
                    warnings=placeholder_warnings,
                )
            file_path.write_text(content, encoding="utf-8")
            add_manifest_path(file_path)
            doc_rel_paths[d.id] = file_path.relative_to(tmpdir)
            if d.id == main_doc.id:
                main_rel_path = file_path.relative_to(tmpdir)

        # Write all file blobs (binary — images, bib, cls, etc.).
        file_rows = (
            db.query(FileBlob)
            .options(
                load_only(
                    FileBlob.id,
                    FileBlob.folder_id,
                    FileBlob.name,
                    FileBlob.blob,
                )
            )
            .filter(FileBlob.project_id == project_id)
            .yield_per(1)
        )
        for f in file_rows:
            folder_path = resolve_folder_path(f.folder_id)
            file_path = folder_path / f.name
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_bytes(f.blob or b"")
            add_manifest_path(file_path)
            db.expunge(f)

        main_parent = main_rel_path.parent
        source_paths = {
            doc_id: self._relative_posix_path(rel_path, main_parent)
            for doc_id, rel_path in doc_rel_paths.items()
        }

        return ProjectTreeWriteResult(
            main_rel_path=main_rel_path,
            warnings=placeholder_warnings,
            source_paths=source_paths,
            workspace_manifest=project_manifest,
        )

    @staticmethod
    def _relative_posix_path(path: Path, base: Path) -> str:
        base_posix = base.as_posix()
        if base_posix in ("", "."):
            return posixpath.normpath(path.as_posix())
        return posixpath.normpath(posixpath.relpath(path.as_posix(), base_posix))

    @staticmethod
    def _workspace_manifest_path(path: Path) -> str:
        return posixpath.normpath(path.as_posix().lstrip("/"))

    def _replace_missing_graphics(
        self,
        content: str,
        *,
        doc_rel_dir: Path,
        project_rel_dir: Path,
        existing_paths: set[str],
        warnings: list[str],
    ) -> str:
        """Replace missing includegraphics calls in the temp compile copy.

        This keeps the user's source untouched while allowing the main PDF to
        render with a visible placeholder box when an image file is missing.
        """

        graphicspaths = self._extract_graphicspaths(content)

        def repl(match: re.Match[str]) -> str:
            target = match.group("target").strip()
            if not target or self._graphics_target_exists(
                target,
                doc_rel_dir=doc_rel_dir,
                project_rel_dir=project_rel_dir,
                graphicspaths=graphicspaths,
                existing_paths=existing_paths,
            ):
                return match.group(0)

            warnings.append(target)
            safe_target = self._latex_escape(target)
            return (
                r"\begingroup"
                r"\setlength{\fboxsep}{6pt}"
                r"\fbox{\begin{minipage}[c][32mm][c]{0.82\linewidth}"
                r"\centering\small Missing image\\"
                rf"\texttt{{{safe_target}}}"
                r"\end{minipage}}"
                r"\endgroup"
            )

        return INCLUDEGRAPHICS_RE.sub(repl, content)

    @staticmethod
    def _graphics_target_exists(
        target: str,
        *,
        doc_rel_dir: Path,
        project_rel_dir: Path,
        graphicspaths: list[str],
        existing_paths: set[str],
    ) -> bool:
        raw = Path(target)
        candidates: list[Path] = []
        search_dirs: list[Path] = [doc_rel_dir, project_rel_dir]
        for entry in graphicspaths:
            entry_path = Path(entry)
            if entry_path.is_absolute():
                search_dirs.append(entry_path)
            else:
                search_dirs.append(doc_rel_dir / entry_path)
                search_dirs.append(project_rel_dir / entry_path)

        base_candidates = [raw] if raw.is_absolute() else [base / raw for base in search_dirs]
        for base in base_candidates:
            if base.suffix:
                candidates.append(base)
            else:
                candidates.extend(Path(f"{base.as_posix()}{ext}") for ext in GRAPHICS_EXTENSIONS)
                candidates.append(base)

        for candidate in candidates:
            normalized = posixpath.normpath(candidate.as_posix().lstrip("/"))
            if normalized in existing_paths:
                return True
        return False

    @staticmethod
    def _extract_graphicspaths(content: str) -> list[str]:
        paths: list[str] = []
        for match in GRAPHICSPATH_RE.finditer(content):
            body = match.group("body")
            for entry in GRAPHICSPATH_ENTRY_RE.finditer(body):
                path = entry.group("path").strip()
                if path:
                    paths.append(path)
        return paths

    @staticmethod
    def _latex_escape(text: str) -> str:
        replacements = {
            "\\": r"\textbackslash{}",
            "{": r"\{",
            "}": r"\}",
            "$": r"\$",
            "&": r"\&",
            "#": r"\#",
            "%": r"\%",
            "_": r"\_",
            "^": r"\textasciicircum{}",
            "~": r"\textasciitilde{}",
        }
        return "".join(replacements.get(ch, ch) for ch in text)

    async def _run_compiler(
        self,
        *,
        tmpdir: Path,
        main_rel_path: Path,
        compiler: str,
        source_paths: dict[str, str],
        output_dir: Path | None = None,
    ) -> CompileResult:
        """Run the chosen compiler and collect output."""
        main_stem = main_rel_path.stem
        working_dir = tmpdir / main_rel_path.parent
        actual_output_dir = output_dir or working_dir
        actual_output_dir.mkdir(parents=True, exist_ok=True)
        jobname = "output"
        env = self._compile_env(tmpdir, working_dir)

        if compiler == "latexmk":
            # latexmk handles multi-pass runs and bibtex automatically.
            runs = [
                [
                    "latexmk",
                    "-norc",
                    "-pdf",
                    "-cd",
                    f"-jobname={jobname}",
                    f"-auxdir={actual_output_dir.as_posix()}",
                    f"-outdir={actual_output_dir.as_posix()}",
                    "-synctex=1",
                    "-interaction=nonstopmode",
                    "-halt-on-error",
                    "-file-line-error",
                    str(main_rel_path.name),
                ]
            ]
        else:
            # Direct compilers do not invoke BibTeX themselves. We run one
            # LaTeX pass to create the .aux, optionally run BibTeX, then run
            # two more LaTeX passes to resolve citations and references.
            base = self._direct_compiler_command(
                compiler, main_rel_path.name,
                output_dir=actual_output_dir, jobname=jobname,
            )
            runs = [base]

        all_log: list[str] = []
        for cmd in runs:
            proc_result = await self._run_command(cmd, cwd=working_dir, env=env)
            if proc_result[0] == "missing":
                return CompileResult(
                    ok=False,
                    pdf=None,
                    synctex=None,
                    log="\n\n".join(all_log),
                    error=f"启动编译器失败：{proc_result[1]}",
                    compiler=compiler,
                    duration_ms=0,
                )
            if proc_result[0] == "timeout":
                return CompileResult(
                    ok=False,
                    pdf=None,
                    synctex=None,
                    log="\n".join(all_log),
                    error="编译超时（120 秒）",
                    compiler=compiler,
                    duration_ms=0,
                )
            returncode = int(proc_result[0])
            output = str(proc_result[1])
            all_log.append(output)
            if returncode != 0 and compiler != "latexmk":
                # Direct compilers: bail on first failing pass.
                break

        if compiler != "latexmk" and all_log:
            aux_path = actual_output_dir / f"{jobname}.aux"
            if self._aux_needs_bibtex(aux_path):
                bib_result = await self._run_command(
                    ["bibtex", f"-output-directory={actual_output_dir.as_posix()}", jobname],
                    cwd=working_dir, env=env,
                )
                if bib_result[0] == "missing":
                    return CompileResult(
                        ok=False,
                        pdf=None,
                        synctex=None,
                        log="\n\n".join(all_log),
                        error=f"启动 BibTeX 失败：{bib_result[1]}",
                        compiler=compiler,
                        duration_ms=0,
                    )
                if bib_result[0] == "timeout":
                    return CompileResult(
                        ok=False,
                        pdf=None,
                        synctex=None,
                        log="\n".join(all_log),
                        error="BibTeX 超时（120 秒）",
                        compiler=compiler,
                        duration_ms=0,
                    )
                all_log.append(str(bib_result[1]))
                if int(bib_result[0]) != 0:
                    full_log = "\n\n".join(all_log)
                    return CompileResult(
                        ok=False,
                        pdf=None,
                        synctex=None,
                        log=full_log[-20000:],
                        error=self._extract_first_error(full_log) or "BibTeX 运行失败。查看日志获取详情。",
                        compiler=compiler,
                        duration_ms=0,
                    )

            base = self._direct_compiler_command(
                compiler, main_rel_path.name,
                output_dir=actual_output_dir, jobname=jobname,
            )
            for _ in range(2):
                proc_result = await self._run_command(base, cwd=working_dir, env=env)
                if proc_result[0] in ("missing", "timeout"):
                    break
                all_log.append(str(proc_result[1]))
                if int(proc_result[0]) != 0:
                    break

        full_log = "\n\n".join(all_log)

        # Check for the output PDF.
        pdf_path = actual_output_dir / f"{jobname}.pdf"
        if pdf_path.exists():
            pdf_bytes = pdf_path.read_bytes()
            synctex_path = actual_output_dir / f"{jobname}.synctex.gz"
            synctex_bytes = synctex_path.read_bytes() if synctex_path.exists() else None
            return CompileResult(
                ok=True,
                pdf=pdf_bytes,
                synctex=synctex_bytes,
                log=full_log[-20000:],  # cap log size
                error="",
                compiler=compiler,
                duration_ms=0,
                source_paths=source_paths,
                main_rel_path=main_rel_path.as_posix(),
            )

        # Extract first error line from the log.
        error_line = self._extract_first_error(full_log)
        return CompileResult(
            ok=False,
            pdf=None,
            synctex=None,
            log=full_log[-20000:],
            error=error_line or "编译失败，未生成 PDF。查看日志获取详情。",
            compiler=compiler,
            duration_ms=0,
        )

    def sync_to_pdf(
        self,
        db: Session,
        project_id: str,
        document_id: str,
        offset: int,
    ) -> dict[str, int | float | None] | None:
        cached = self._pdf_cache.get(project_id)
        if cached is None or not cached.ok or cached.pdf is None or cached.synctex is None:
            return None

        doc = db.get(Doc, document_id)
        if doc is None or doc.project_id != project_id:
            return None

        source_path = cached.source_paths.get(document_id)
        if not source_path:
            return None

        line, column = self._line_column_from_offset(doc.content or "", offset)
        with tempfile.TemporaryDirectory(prefix="ylw-synctex-") as tmp:
            tmpdir = Path(tmp)
            pdf_path = tmpdir / "output.pdf"
            synctex_path = tmpdir / "output.synctex.gz"
            pdf_path.write_bytes(cached.pdf)
            synctex_path.write_bytes(cached.synctex)

            # Some synctex versions resolve relative source paths against cwd.
            source_file = tmpdir / source_path
            source_file.parent.mkdir(parents=True, exist_ok=True)
            source_file.write_text(doc.content or "", encoding="utf-8")

            try:
                proc = subprocess.run(
                    [
                        "synctex",
                        "view",
                        "-i",
                        f"{line}:{column}:{source_path}",
                        "-o",
                        str(pdf_path),
                    ],
                    cwd=tmpdir,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=10,
                    check=False,
                )
            except (FileNotFoundError, subprocess.TimeoutExpired):
                return None

        if proc.returncode != 0:
            return None

        parsed = self._parse_synctex_view_output(proc.stdout)
        if parsed is None:
            return None
        parsed["line"] = line
        parsed["column"] = column
        return parsed

    def sync_from_pdf(
        self,
        db: Session,
        project_id: str,
        *,
        page: int,
        x: float,
        y: float,
    ) -> dict[str, int | str] | None:
        cached = self._pdf_cache.get(project_id)
        if cached is None or not cached.ok or cached.pdf is None or cached.synctex is None:
            return None

        with tempfile.TemporaryDirectory(prefix="ylw-synctex-") as tmp:
            tmpdir = Path(tmp)
            pdf_path = tmpdir / "output.pdf"
            synctex_path = tmpdir / "output.synctex.gz"
            pdf_path.write_bytes(cached.pdf)
            synctex_path.write_bytes(cached.synctex)

            try:
                proc = subprocess.run(
                    [
                        "synctex",
                        "edit",
                        "-o",
                        f"{page}:{x}:{y}:{pdf_path}",
                    ],
                    cwd=tmpdir,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=10,
                    check=False,
                )
            except (FileNotFoundError, subprocess.TimeoutExpired):
                return None

            if proc.returncode != 0:
                return None

            parsed = self._parse_synctex_edit_output(proc.stdout)
            if parsed is None:
                return None

            match = self._match_synctex_source_path(
                str(parsed["source_path"]),
                cached.source_paths,
                tmpdir,
            )
            if match is None:
                return None
            document_id, source_path = match

        doc = db.get(Doc, document_id)
        if doc is None or doc.project_id != project_id:
            return None

        line = int(parsed["line"])
        column = int(parsed["column"])
        return {
            "document_id": document_id,
            "offset": self._offset_from_line_column(doc.content or "", line, column),
            "line": line,
            "column": column,
            "source_path": source_path,
        }

    @staticmethod
    def _line_column_from_offset(source: str, offset: int) -> tuple[int, int]:
        safe_offset = max(0, min(offset, len(source)))
        prefix = source[:safe_offset]
        line = prefix.count("\n") + 1
        last_newline = prefix.rfind("\n")
        column = safe_offset if last_newline < 0 else safe_offset - last_newline - 1
        return line, column

    @staticmethod
    def _offset_from_line_column(source: str, line: int, column: int) -> int:
        if line <= 1:
            line_start = 0
        else:
            current_line = 1
            line_start = len(source)
            for index, char in enumerate(source):
                if char != "\n":
                    continue
                current_line += 1
                if current_line == line:
                    line_start = index + 1
                    break

        if column < 0:
            return line_start

        line_end = source.find("\n", line_start)
        if line_end < 0:
            line_end = len(source)
        return max(0, min(line_start + column, line_end, len(source)))

    @staticmethod
    def _parse_synctex_view_output(output: str) -> dict[str, int | float | None] | None:
        values: dict[str, float] = {}
        for raw_line in output.splitlines():
            if ":" not in raw_line:
                continue
            key, raw_value = raw_line.split(":", 1)
            key = key.strip()
            if key not in {"Page", "x", "y", "h", "v", "W", "H"}:
                continue
            try:
                values[key] = float(raw_value.strip())
            except ValueError:
                continue

        page = values.get("Page")
        x = values.get("x", values.get("h"))
        y = values.get("y", values.get("v"))
        if page is None or x is None or y is None:
            return None
        return {
            "page": int(page),
            "x": x,
            "y": y,
            "width": values.get("W"),
            "height": values.get("H"),
        }

    @staticmethod
    def _parse_synctex_edit_output(output: str) -> dict[str, int | str] | None:
        source_path: str | None = None
        line: int | None = None
        column = -1
        for raw_line in output.splitlines():
            if ":" not in raw_line:
                continue
            key, raw_value = raw_line.split(":", 1)
            key = key.strip()
            value = raw_value.strip()
            if key == "Input":
                source_path = value
            elif key == "Line":
                try:
                    line = int(value)
                except ValueError:
                    return None
            elif key == "Column":
                try:
                    column = int(value)
                except ValueError:
                    column = -1

        if not source_path or line is None:
            return None
        return {
            "source_path": source_path,
            "line": line,
            "column": column,
        }

    @classmethod
    def _match_synctex_source_path(
        cls,
        input_path: str,
        source_paths: dict[str, str],
        tmpdir: Path | None = None,
    ) -> tuple[str, str] | None:
        normalized_input = cls._normalize_synctex_path(input_path, tmpdir)
        matches: list[tuple[str, str]] = []

        for document_id, source_path in source_paths.items():
            for candidate in cls._source_path_candidates(source_path):
                if normalized_input == candidate or normalized_input.endswith(f"/{candidate}"):
                    matches.append((document_id, source_path))
                    break

        if len(matches) != 1:
            return None
        return matches[0]

    @staticmethod
    def _normalize_synctex_path(path: str, tmpdir: Path | None = None) -> str:
        normalized = path.strip().replace("\\", "/")
        if tmpdir is not None:
            raw_path = Path(normalized)
            if raw_path.is_absolute():
                resolved = raw_path.resolve(strict=False).as_posix()
                tmp_resolved = tmpdir.resolve(strict=False).as_posix()
                if resolved == tmp_resolved:
                    normalized = "."
                elif resolved.startswith(f"{tmp_resolved}/"):
                    normalized = resolved[len(tmp_resolved) + 1 :]
        normalized = posixpath.normpath(normalized)
        if normalized.startswith("./"):
            normalized = normalized[2:]
        return normalized

    @classmethod
    def _source_path_candidates(cls, source_path: str) -> set[str]:
        normalized = cls._normalize_synctex_path(source_path)
        candidates = {normalized}
        stripped = normalized
        while stripped.startswith("../"):
            stripped = stripped[3:]
            candidates.add(stripped)
        if stripped.startswith("./"):
            candidates.add(stripped[2:])
        return {candidate for candidate in candidates if candidate and candidate != "."}

    @staticmethod
    def _extract_first_error(log: str) -> str:
        """Pull the first informative error message from a LaTeX log."""
        # `-file-line-error` puts errors in the form `path:line: msg`.
        for line in log.splitlines():
            stripped = line.strip()
            if (
                stripped.startswith("!")
                or ":" in stripped[:60] and ("Error" in stripped or "error" in stripped)
            ):
                return stripped[:300]
        return ""

    @staticmethod
    async def _run_command(
        cmd: list[str], *, cwd: Path, env: dict[str, str]
    ) -> tuple[int | str, str]:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=env,
                preexec_fn=LatexCompilerService._apply_compile_resource_limits,
            )
        except FileNotFoundError as e:
            return "missing", str(e)
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
        except TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return "timeout", ""
        output = stdout.decode("utf-8", errors="replace") if stdout else ""
        return proc.returncode, output

    @staticmethod
    def _apply_compile_resource_limits() -> None:
        limits = [
            ("RLIMIT_CPU", COMPILE_CPU_LIMIT_SECONDS),
            ("RLIMIT_FSIZE", COMPILE_FILE_SIZE_LIMIT_BYTES),
            ("RLIMIT_NPROC", COMPILE_PROCESS_LIMIT),
            ("RLIMIT_AS", COMPILE_ADDRESS_SPACE_LIMIT_BYTES),
        ]
        for name, value in limits:
            limit = getattr(resource, name, None)
            if limit is None:
                continue
            try:
                _set_child_resource_limit(limit, value)
            except (OSError, ValueError):
                continue

    @staticmethod
    def _aux_needs_bibtex(aux_path: Path) -> bool:
        if not aux_path.exists():
            return False
        try:
            content = aux_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return False
        return "\\bibdata" in content

    @staticmethod
    def _compile_env(tmpdir: Path, working_dir: Path) -> dict[str, str]:
        """Search project resources recursively while preserving system paths."""
        env = os.environ.copy()
        search_paths = [f"{working_dir.as_posix()}//", f"{tmpdir.as_posix()}//", ""]
        joined = os.pathsep.join(search_paths)
        for key in ("TEXINPUTS", "BIBINPUTS", "BSTINPUTS"):
            env[key] = joined
        env["openin_any"] = TEX_FILE_ACCESS_POLICY
        env["openout_any"] = TEX_FILE_ACCESS_POLICY
        return env

    @staticmethod
    def _direct_compiler_command(
        compiler: str,
        main_name: str,
        *,
        output_dir: Path | None = None,
        jobname: str | None = None,
    ) -> list[str]:
        cmd = [
            compiler,
            *DIRECT_COMPILER_SECURITY_ARGS,
            "-synctex=1",
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
        ]
        if output_dir is not None:
            cmd.append(f"-output-directory={output_dir.as_posix()}")
        if jobname is not None:
            cmd.append(f"-jobname={jobname}")
        cmd.append(main_name)
        return cmd


# Module-level singleton. API routes call `get_compiler_service()` to access it.
_compiler_service: LatexCompilerService | None = None


def get_compiler_service() -> LatexCompilerService:
    global _compiler_service
    if _compiler_service is None:
        _compiler_service = LatexCompilerService()
    return _compiler_service


def _set_child_resource_limit(limit: int, desired: int) -> None:
    current_soft, current_hard = resource.getrlimit(limit)
    hard = desired if current_hard == resource.RLIM_INFINITY else min(current_hard, desired)
    soft = desired if current_soft == resource.RLIM_INFINITY else min(current_soft, desired)
    soft = min(soft, hard)
    resource.setrlimit(limit, (soft, hard))


def _validate_compile_entry_name(name: str, *, field: str) -> str:
    cleaned = validate_project_entry_name(name, field=field)
    if cleaned.casefold() in COMPILER_CONTROL_FILENAMES:
        raise ProjectEntryNameError(f"{field} must not be a compiler control file")
    return cleaned

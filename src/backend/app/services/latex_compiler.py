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
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import Doc, FileBlob, Folder, Project


# All known TeX Live / MacTeX binaries we'll try to detect.
KNOWN_COMPILERS = ("latexmk", "pdflatex", "xelatex", "lualatex")


@dataclass
class CompileResult:
    ok: bool
    pdf: bytes | None
    log: str
    error: str
    compiler: str
    duration_ms: int
    started_at: float = field(default_factory=time.time)


class LatexCompilerService:
    """Stateful service. One instance per process — holds the PDF cache."""

    def __init__(self) -> None:
        self._available_compilers = self._detect_compilers()
        # project_id -> CompileResult
        self._pdf_cache: dict[str, CompileResult] = {}

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
        else:
            self._pdf_cache.pop(project_id, None)

    # ----------------------------------------------------------- compile

    async def compile_project(
        self,
        db: Session,
        project_id: str,
        *,
        main_doc_id: str | None = None,
        compiler: str | None = None,
    ) -> CompileResult:
        """Compile the project and cache the result.

        If `main_doc_id` is None, picks the first tex doc with name 'main.tex'
        at project root, or any .tex file at root, or the first .tex anywhere.
        If `compiler` is None, picks latexmk when available, else the first
        detected compiler.
        """
        started = time.time()

        if not self._available_compilers:
            result = CompileResult(
                ok=False,
                pdf=None,
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
                log="",
                error="项目中找不到可编译的 .tex 文件。",
                compiler=chosen_compiler,
                duration_ms=int((time.time() - started) * 1000),
            )
            self._pdf_cache[project_id] = result
            return result

        # Write project tree to temp dir and compile.
        with tempfile.TemporaryDirectory(prefix="ylw-tex-") as tmp:
            tmpdir = Path(tmp)
            main_rel_path = self._write_project_tree(db, project_id, tmpdir, main_doc)

            result = await self._run_compiler(
                tmpdir=tmpdir,
                main_rel_path=main_rel_path,
                compiler=chosen_compiler,
            )

        result.duration_ms = int((time.time() - started) * 1000)
        self._pdf_cache[project_id] = result
        return result

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
    ) -> Path:
        """Write all docs + files of the project into tmpdir, preserving folder
        structure. Returns the relative path of the main doc within tmpdir."""

        folders = (
            db.query(Folder).filter(Folder.project_id == project_id).all()
        )
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

        # Write all docs (text).
        docs = db.query(Doc).filter(Doc.project_id == project_id).all()
        main_rel_path = Path(main_doc.name)
        for d in docs:
            folder_path = resolve_folder_path(d.folder_id)
            file_path = folder_path / d.name
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(d.content or "", encoding="utf-8")
            if d.id == main_doc.id:
                main_rel_path = file_path.relative_to(tmpdir)

        # Write all file blobs (binary — images, bib, cls, etc.).
        files = db.query(FileBlob).filter(FileBlob.project_id == project_id).all()
        for f in files:
            folder_path = resolve_folder_path(f.folder_id)
            file_path = folder_path / f.name
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_bytes(f.blob or b"")

        return main_rel_path

    async def _run_compiler(
        self, *, tmpdir: Path, main_rel_path: Path, compiler: str
    ) -> CompileResult:
        """Run the chosen compiler and collect output."""
        main_stem = main_rel_path.stem
        working_dir = tmpdir / main_rel_path.parent

        if compiler == "latexmk":
            # latexmk handles multi-pass runs and bibtex automatically.
            cmd = [
                "latexmk",
                "-pdf",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-file-line-error",
                str(main_rel_path.name),
            ]
            runs = [cmd]
        else:
            # Simple 2-pass: the second pass resolves \ref / \cite.
            base = [
                compiler,
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-file-line-error",
                str(main_rel_path.name),
            ]
            runs = [base, base]

        all_log: list[str] = []
        for cmd in runs:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    cwd=working_dir,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
            except FileNotFoundError as e:
                return CompileResult(
                    ok=False,
                    pdf=None,
                    log="",
                    error=f"启动编译器失败：{e}",
                    compiler=compiler,
                    duration_ms=0,
                )
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                return CompileResult(
                    ok=False,
                    pdf=None,
                    log="\n".join(all_log),
                    error="编译超时（120 秒）",
                    compiler=compiler,
                    duration_ms=0,
                )
            output = stdout.decode("utf-8", errors="replace") if stdout else ""
            all_log.append(output)
            if proc.returncode != 0 and compiler != "latexmk":
                # Direct compilers: bail on first failing pass.
                break

        full_log = "\n\n".join(all_log)

        # Check for the output PDF.
        pdf_path = working_dir / f"{main_stem}.pdf"
        if pdf_path.exists():
            pdf_bytes = pdf_path.read_bytes()
            return CompileResult(
                ok=True,
                pdf=pdf_bytes,
                log=full_log[-20000:],  # cap log size
                error="",
                compiler=compiler,
                duration_ms=0,
            )

        # Extract first error line from the log.
        error_line = self._extract_first_error(full_log)
        return CompileResult(
            ok=False,
            pdf=None,
            log=full_log[-20000:],
            error=error_line or "编译失败，未生成 PDF。查看日志获取详情。",
            compiler=compiler,
            duration_ms=0,
        )

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


# Module-level singleton. API routes call `get_compiler_service()` to access it.
_compiler_service: LatexCompilerService | None = None


def get_compiler_service() -> LatexCompilerService:
    global _compiler_service
    if _compiler_service is None:
        _compiler_service = LatexCompilerService()
    return _compiler_service

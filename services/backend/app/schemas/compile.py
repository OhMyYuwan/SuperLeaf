"""LaTeX 编译与 SyncTeX schema。"""

from __future__ import annotations

from pydantic import BaseModel


class CompilerInfoOut(BaseModel):
    available: list[str]
    default: str


class CompileIn(BaseModel):
    compiler: str | None = None
    main_doc_id: str | None = None


class CompileOut(BaseModel):
    ok: bool
    compiler: str
    duration_ms: int
    error: str
    # Truncated log preview. Full log is fetched via /api/compile/log.
    log_tail: str
    # Length of the PDF blob in bytes (0 if no PDF).
    pdf_bytes: int


class CompileSyncToPdfIn(BaseModel):
    document_id: str
    offset: int


class CompileSyncToPdfOut(BaseModel):
    page: int
    x: float
    y: float
    width: float | None = None
    height: float | None = None
    line: int
    column: int


class CompileSyncFromPdfIn(BaseModel):
    page: int
    x: float
    y: float


class CompileSyncFromPdfOut(BaseModel):
    document_id: str
    offset: int
    line: int
    column: int
    source_path: str

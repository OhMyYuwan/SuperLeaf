"""/api/compile — LaTeX compilation endpoints.

Design notes:
- `POST /api/compile` runs a fresh compile synchronously and caches the result.
- `GET /api/projects/{pid}/compile.pdf` returns the cached PDF. We scope it by
  path (not header) so plain <a download>, <img src>, and share links work
  without needing to inject X-Project-Id via fetch.
- `GET /api/compile/log` returns the full log text.
- `GET /api/compile/compilers` lists available system compilers.
- `GET/PUT /api/compile/settings` manages per-project compile settings.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Doc, Project
from ..schemas import (
    CompileIn,
    CompileOut,
    CompilerInfoOut,
    CompileSyncFromPdfIn,
    CompileSyncFromPdfOut,
    CompileSyncToPdfIn,
    CompileSyncToPdfOut,
    ProjectCompileSettingsIn,
    ProjectCompileSettingsOut,
)
from ..services.latex_compiler import get_compiler_service
from .deps import get_current_project, get_project_from_path, require_write_access

router = APIRouter(prefix="/api/compile", tags=["compile"])

# Path-scoped router for binary artefacts that should be reachable via a
# self-contained URL (downloads, <img src>, future share links).
projects_router = APIRouter(prefix="/api/projects", tags=["compile"])


@router.get("/compilers", response_model=CompilerInfoOut)
def list_compilers() -> CompilerInfoOut:
    svc = get_compiler_service()
    available = svc.available_compilers
    default = ""
    if "latexmk" in available:
        default = "latexmk"
    elif available:
        default = available[0]
    return CompilerInfoOut(available=available, default=default)


@router.post("/rescan", response_model=CompilerInfoOut)
def rescan_compilers() -> CompilerInfoOut:
    svc = get_compiler_service()
    svc.rescan_compilers()
    return list_compilers()


@router.post("", response_model=CompileOut)
async def compile_project(
    body: CompileIn,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
) -> CompileOut:
    # Resolve settings: explicit body > project-level saved > service default.
    compiler = body.compiler or project.compiler or None
    requested_main_doc_id = body.main_doc_id if body.main_doc_id is not None else project.main_doc_id
    main_doc_id = _validate_main_doc_id(db, project, requested_main_doc_id)

    svc = get_compiler_service()
    result = await svc.compile_project(
        db,
        project.id,
        main_doc_id=main_doc_id,
        compiler=compiler,
    )
    return CompileOut(
        ok=result.ok,
        compiler=result.compiler,
        duration_ms=result.duration_ms,
        error=result.error,
        log_tail=result.log[-4000:],
        pdf_bytes=len(result.pdf or b""),
    )


@router.post("/sync-to-pdf", response_model=CompileSyncToPdfOut)
def sync_to_pdf(
    body: CompileSyncToPdfIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> CompileSyncToPdfOut:
    svc = get_compiler_service()
    result = svc.sync_to_pdf(
        db,
        project.id,
        document_id=body.document_id,
        offset=body.offset,
    )
    if result is None:
        raise HTTPException(
            404,
            "No SyncTeX position found. Compile the latest PDF first.",
        )
    return CompileSyncToPdfOut(**result)


@router.post("/sync-from-pdf", response_model=CompileSyncFromPdfOut)
def sync_from_pdf(
    body: CompileSyncFromPdfIn,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> CompileSyncFromPdfOut:
    svc = get_compiler_service()
    result = svc.sync_from_pdf(
        db,
        project.id,
        page=body.page,
        x=body.x,
        y=body.y,
    )
    if result is None:
        raise HTTPException(
            404,
            "No SyncTeX source position found. Compile the latest PDF first.",
        )
    return CompileSyncFromPdfOut(**result)


@router.get("/log", response_class=Response)
def get_compile_log(
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> Response:
    svc = get_compiler_service()
    cached = svc.get_cached(project.id)
    if cached is None:
        raise HTTPException(404, "No compile log yet.")
    return Response(content=cached.log, media_type="text/plain; charset=utf-8")


@projects_router.get("/{project_id}/compile.pdf")
def get_compiled_pdf(
    request: Request,
    project: Project = Depends(get_project_from_path),
) -> Response:
    svc = get_compiler_service()
    cached = svc.get_cached(project.id)
    if cached is None or cached.pdf is None:
        raise HTTPException(404, "No compiled PDF yet. Call POST /api/compile first.")
    pdf = cached.pdf
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": 'inline; filename="compile.pdf"',
    }
    byte_range = _parse_single_byte_range(request.headers.get("range"), len(pdf))
    if byte_range is None:
        headers["Content-Length"] = str(len(pdf))
        return Response(content=pdf, media_type="application/pdf", headers=headers)

    start, end = byte_range
    chunk = pdf[start : end + 1]
    headers.update(
        {
            "Content-Range": f"bytes {start}-{end}/{len(pdf)}",
            "Content-Length": str(len(chunk)),
        }
    )
    return Response(
        content=chunk,
        status_code=206,
        media_type="application/pdf",
        headers=headers,
    )


def _parse_single_byte_range(range_header: str | None, content_length: int) -> tuple[int, int] | None:
    if not range_header:
        return None
    if not range_header.startswith("bytes=") or "," in range_header:
        raise HTTPException(
            416,
            "Unsupported Range header.",
            headers={"Content-Range": f"bytes */{content_length}", "Accept-Ranges": "bytes"},
        )

    raw_start, sep, raw_end = range_header.removeprefix("bytes=").partition("-")
    if sep != "-":
        raise HTTPException(
            416,
            "Invalid Range header.",
            headers={"Content-Range": f"bytes */{content_length}", "Accept-Ranges": "bytes"},
        )

    try:
        if raw_start == "":
            suffix_length = int(raw_end)
            if suffix_length <= 0:
                raise ValueError
            start = max(content_length - suffix_length, 0)
            end = content_length - 1
        else:
            start = int(raw_start)
            end = int(raw_end) if raw_end else content_length - 1
    except ValueError as exc:
        raise HTTPException(
            416,
            "Invalid Range header.",
            headers={"Content-Range": f"bytes */{content_length}", "Accept-Ranges": "bytes"},
        ) from exc

    if content_length <= 0 or start < 0 or end < start or start >= content_length:
        raise HTTPException(
            416,
            "Requested range is not satisfiable.",
            headers={"Content-Range": f"bytes */{content_length}", "Accept-Ranges": "bytes"},
        )
    return start, min(end, content_length - 1)


@router.get("/settings", response_model=ProjectCompileSettingsOut)
def get_settings(
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> ProjectCompileSettingsOut:
    return ProjectCompileSettingsOut(
        main_doc_id=project.main_doc_id,
        compiler=project.compiler,
    )


@router.put("/settings", response_model=ProjectCompileSettingsOut)
def update_settings(
    body: ProjectCompileSettingsIn,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
) -> ProjectCompileSettingsOut:
    if body.main_doc_id is not None:
        project.main_doc_id = _validate_main_doc_id(db, project, body.main_doc_id) or ""
    if body.compiler is not None:
        project.compiler = body.compiler
    db.commit()
    db.refresh(project)
    return ProjectCompileSettingsOut(
        main_doc_id=project.main_doc_id,
        compiler=project.compiler,
    )


def _validate_main_doc_id(db: Session, project: Project, main_doc_id: str | None) -> str | None:
    if not main_doc_id:
        return None
    doc = db.get(Doc, main_doc_id)
    if doc is None or doc.project_id != project.id:
        raise HTTPException(400, "main_doc_id must belong to the current project")
    if doc.format != "tex":
        raise HTTPException(400, "main_doc_id must reference a tex document")
    return doc.id

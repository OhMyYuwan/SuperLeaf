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

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Project
from ..schemas import (
    CompileIn,
    CompileOut,
    CompilerInfoOut,
    ProjectCompileSettingsIn,
    ProjectCompileSettingsOut,
)
from ..services.latex_compiler import get_compiler_service
from .deps import get_current_project, get_project_from_path

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
    project: Project = Depends(get_current_project),
) -> CompileOut:
    # Resolve settings: explicit body > project-level saved > service default.
    compiler = body.compiler or project.compiler or None
    main_doc_id = body.main_doc_id or project.main_doc_id or None

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
    project: Project = Depends(get_project_from_path),
) -> Response:
    svc = get_compiler_service()
    cached = svc.get_cached(project.id)
    if cached is None or cached.pdf is None:
        raise HTTPException(404, "No compiled PDF yet. Call POST /api/compile first.")
    return Response(content=cached.pdf, media_type="application/pdf")


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
    project: Project = Depends(get_current_project),
) -> ProjectCompileSettingsOut:
    if body.main_doc_id is not None:
        project.main_doc_id = body.main_doc_id
    if body.compiler is not None:
        project.compiler = body.compiler
    db.commit()
    db.refresh(project)
    return ProjectCompileSettingsOut(
        main_doc_id=project.main_doc_id,
        compiler=project.compiler,
    )

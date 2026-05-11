"""Local project filesystem routes (A1-A3).

A1: GET /api/project/tree, POST /api/folders, POST/GET/PUT /api/docs
A3: POST /api/entities/:type/:id/rename, DELETE /api/entities/:type/:id,
    POST /api/files/upload, GET /api/project/export.zip
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, UploadFile, Form
from fastapi.responses import Response

from ..models import FileBlob
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_session
from ..schemas import (
    DocCreateIn,
    DocOut,
    DocUpdateIn,
    FolderCreateIn,
    FolderOut,
    ProjectTreeOut,
)
from ..services.project_fs_service import ProjectFsService

router = APIRouter(tags=["filesystem"])


@router.get("/api/project/tree", response_model=ProjectTreeOut)
def get_project_tree(db: Session = Depends(get_session)) -> ProjectTreeOut:
    return ProjectFsService(db).get_tree()


class ProjectRenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=128)


@router.put("/api/project/name", status_code=200)
def rename_project(body: ProjectRenameBody, db: Session = Depends(get_session)) -> dict:
    ProjectFsService(db).rename_project(body.name)
    return {"ok": True}


@router.post("/api/folders", response_model=FolderOut, status_code=201)
def create_folder(body: FolderCreateIn, db: Session = Depends(get_session)) -> FolderOut:
    svc = ProjectFsService(db)
    try:
        folder = svc.create_folder(parent_folder_id=body.parent_folder_id, name=body.name)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return FolderOut.model_validate(folder)


@router.post("/api/docs", response_model=DocOut, status_code=201)
def create_doc(body: DocCreateIn, db: Session = Depends(get_session)) -> DocOut:
    svc = ProjectFsService(db)
    try:
        doc = svc.create_doc(
            folder_id=body.folder_id,
            name=body.name,
            format=body.format,
            content=body.content,
        )
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return DocOut.model_validate(doc)


@router.get("/api/docs/{doc_id}", response_model=DocOut)
def get_doc(doc_id: str, db: Session = Depends(get_session)) -> DocOut:
    doc = ProjectFsService(db).get_doc(doc_id)
    if doc is None:
        raise HTTPException(404, "doc not found")
    return DocOut.model_validate(doc)


@router.put("/api/docs/{doc_id}", response_model=DocOut)
def update_doc(doc_id: str, body: DocUpdateIn, db: Session = Depends(get_session)) -> DocOut:
    doc = ProjectFsService(db).update_doc_content(doc_id, body.content)
    if doc is None:
        raise HTTPException(404, "doc not found")
    return DocOut.model_validate(doc)


# ---------------------------------------------------------------------------
# A3: rename / delete / upload / export
# ---------------------------------------------------------------------------


class RenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=256)


@router.post("/api/entities/{entity_type}/{entity_id}/rename", status_code=200)
def rename_entity(
    entity_type: str,
    entity_id: str,
    body: RenameBody,
    db: Session = Depends(get_session),
) -> dict:
    if entity_type not in ("folder", "doc", "file"):
        raise HTTPException(400, "entity_type must be folder|doc|file")
    ok = ProjectFsService(db).rename_entity(entity_type, entity_id, body.name)
    if not ok:
        raise HTTPException(404, "entity not found")
    return {"ok": True}


@router.delete("/api/entities/{entity_type}/{entity_id}", status_code=200)
def delete_entity(
    entity_type: str,
    entity_id: str,
    db: Session = Depends(get_session),
) -> dict:
    if entity_type not in ("folder", "doc", "file"):
        raise HTTPException(400, "entity_type must be folder|doc|file")
    count = ProjectFsService(db).delete_entity(entity_type, entity_id)
    if count == 0:
        raise HTTPException(404, "entity not found")
    return {"ok": True, "deleted_count": count}


class MoveBody(BaseModel):
    target_folder_id: str | None = None


@router.post("/api/entities/{entity_type}/{entity_id}/move", status_code=200)
def move_entity(
    entity_type: str,
    entity_id: str,
    body: MoveBody,
    db: Session = Depends(get_session),
) -> dict:
    if entity_type not in ("folder", "doc", "file"):
        raise HTTPException(400, "entity_type must be folder|doc|file")
    ok, err = ProjectFsService(db).move_entity(entity_type, entity_id, body.target_folder_id)
    if not ok:
        # Cycle / not-found errors → 400 / 404 respectively.
        status = 404 if err and "not found" in err else 400
        raise HTTPException(status, err or "move failed")
    return {"ok": True}


_TEXT_DOC_EXTS: dict[str, str] = {
    # extension (no dot, lowercase) -> stored Doc.format
    "tex": "tex",
    "latex": "tex",
    "ltx": "tex",
    "bib": "tex",
    "sty": "tex",
    "cls": "tex",
    "bst": "tex",
    "md": "md",
    "markdown": "md",
    "txt": "txt",
}


def _doc_format_for_filename(name: str) -> str | None:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return _TEXT_DOC_EXTS.get(ext)


@router.post("/api/files/upload", status_code=201)
async def upload_file(
    file: UploadFile,
    folder_id: str | None = Form(None),
    db: Session = Depends(get_session),
) -> dict:
    blob = await file.read()
    name = file.filename or "untitled"
    svc = ProjectFsService(db)

    # Text-like uploads go into `docs` so they can be opened in the editor.
    doc_format = _doc_format_for_filename(name)
    if doc_format is not None:
        try:
            content = blob.decode("utf-8")
        except UnicodeDecodeError:
            # Fallback: if decoding fails, treat as binary file instead.
            doc_format = None

    if doc_format is not None:
        try:
            d = svc.create_doc(
                folder_id=folder_id,
                name=name,
                format=doc_format,
                content=content,
            )
        except ValueError as e:
            raise HTTPException(404, str(e)) from e
        return {
            "kind": "doc",
            "id": d.id,
            "name": d.name,
            "format": d.format,
        }

    # Improve MIME type detection: use mimetypes module if content_type is missing or generic
    mime_type = file.content_type or "application/octet-stream"
    if mime_type == "application/octet-stream" or not mime_type:
        mime_type = _guess_mime(name, mime_type)

    try:
        f = svc.upload_file(
            folder_id=folder_id,
            name=name,
            mime_type=mime_type,
            blob=blob,
        )
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {
        "kind": "file",
        "id": f.id,
        "name": f.name,
        "size_bytes": f.size_bytes,
        "mime_type": f.mime_type,
    }


_INLINE_MIME_PREFIXES = ("image/", "text/", "audio/", "video/")
_INLINE_MIME_EXACT = {
    "application/pdf",
    "application/json",
    "application/xml",
    "application/x-tex",
    "application/x-latex",
    "application/javascript",
    "application/x-yaml",
    "application/yaml",
}


def _guess_mime(name: str, stored: str) -> str:
    """Upgrade application/octet-stream by filename extension when possible."""
    if stored and stored != "application/octet-stream":
        return stored
    import mimetypes

    guessed, _ = mimetypes.guess_type(name)
    return guessed or stored or "application/octet-stream"


@router.get("/api/files/{file_id}")
def get_file(file_id: str, db: Session = Depends(get_session)) -> Response:
    f = db.get(FileBlob, file_id)
    if f is None:
        raise HTTPException(404, "file not found")
    mime = _guess_mime(f.name, f.mime_type)
    inline = mime.startswith(_INLINE_MIME_PREFIXES) or mime in _INLINE_MIME_EXACT
    disposition = "inline" if inline else "attachment"
    # RFC 5987 filename* for non-ASCII names
    quoted = quote(f.name)
    return Response(
        content=f.blob or b"",
        media_type=mime,
        headers={
            "Content-Disposition": f"{disposition}; filename*=UTF-8''{quoted}",
            "Content-Length": str(len(f.blob or b"")),
        },
    )


@router.post("/api/files/{file_id}/convert-to-doc", response_model=DocOut, status_code=201)
def convert_file_to_doc(file_id: str, db: Session = Depends(get_session)) -> DocOut:
    """Migrate a text-like FileBlob (uploaded before the split into docs/files) into `docs`.

    Deletes the original FileBlob on success so the tree stays de-duplicated.
    """
    f = db.get(FileBlob, file_id)
    if f is None:
        raise HTTPException(404, "file not found")
    fmt = _doc_format_for_filename(f.name)
    if fmt is None:
        raise HTTPException(400, "file is not a recognized text format")
    try:
        content = (f.blob or b"").decode("utf-8")
    except UnicodeDecodeError as e:
        raise HTTPException(400, "file is not valid UTF-8 text") from e
    svc = ProjectFsService(db)
    doc = svc.create_doc(folder_id=f.folder_id, name=f.name, format=fmt, content=content)
    db.delete(f)
    db.commit()
    return DocOut.model_validate(doc)


@router.get("/api/project/export.zip")
def export_zip(db: Session = Depends(get_session)) -> Response:
    data = ProjectFsService(db).export_zip()
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=project.zip"},
    )

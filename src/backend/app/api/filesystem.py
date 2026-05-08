"""Local project filesystem routes (A1-A3).

A1: GET /api/project/tree, POST /api/folders, POST/GET/PUT /api/docs
A3: POST /api/entities/:type/:id/rename, DELETE /api/entities/:type/:id,
    POST /api/files/upload, GET /api/project/export.zip
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import Response
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


@router.post("/api/files/upload", status_code=201)
async def upload_file(
    file: UploadFile,
    folder_id: str | None = None,
    db: Session = Depends(get_session),
) -> dict:
    blob = await file.read()
    svc = ProjectFsService(db)
    try:
        f = svc.upload_file(
            folder_id=folder_id,
            name=file.filename or "untitled",
            mime_type=file.content_type or "application/octet-stream",
            blob=blob,
        )
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {"id": f.id, "name": f.name, "size_bytes": f.size_bytes, "mime_type": f.mime_type}


@router.get("/api/project/export.zip")
def export_zip(db: Session = Depends(get_session)) -> Response:
    data = ProjectFsService(db).export_zip()
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=project.zip"},
    )

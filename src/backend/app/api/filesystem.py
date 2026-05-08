"""Local project filesystem routes (A1).

Scope for A1:
- GET /api/project/tree
- POST /api/folders
- POST /api/docs
- GET /api/docs/{doc_id}
- PUT /api/docs/{doc_id}

Delete/rename/move/upload/export are A2/A3.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
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

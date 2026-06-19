"""Local project filesystem routes (A1-A3).

A1: GET /api/project/tree, POST /api/folders, POST/GET/PUT /api/docs
A3: POST /api/entities/:type/:id/rename, DELETE /api/entities/:type/:id,
    POST /api/files/upload, GET /api/project/export.zip
"""

from __future__ import annotations

from datetime import UTC
from email.utils import format_datetime, parsedate_to_datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Doc, FileBlob, Folder, Project, User
from ..schemas import (
    DocCreateIn,
    DocOut,
    DocUpdateIn,
    FolderCreateIn,
    FolderOut,
    ProjectTreeOut,
)
from ..services import collab_snapshot_service
from ..services.auth_service import AuthService
from ..services.collab_audit_log import record_collab_event
from ..services.event_bus import bus
from ..services.markitdown_service import MarkItDownService
from ..services.project_entry_name import ProjectEntryNameError, validate_project_entry_name
from ..services.project_fs_service import (
    DocVersionConflictError,
    ProjectFsService,
    doc_format_for_name,
    is_text_payload,
)
from ..services.project_member_service import ProjectMemberService
from .collab_consistency import (
    flush_project_collab_or_503,
    flush_project_collab_or_503_sync,
    invalidate_collab_docs_or_503,
    sync_project_collab_from_db_or_503,
)
from .deps import (
    get_current_project,
    get_current_user,
    get_optional_current_user,
    get_project_from_path,
    require_write_access,
)

router = APIRouter(tags=["filesystem"])

# Path-scoped router for binary downloads (zip export, future raw asset URLs)
# where the URL must self-contain the project id so plain <a download> works
# without a JS fetch wrapper to inject X-Project-Id.
projects_router = APIRouter(prefix="/api/projects", tags=["filesystem"])


@router.get("/api/project/tree", response_model=ProjectTreeOut)
def get_project_tree(
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> ProjectTreeOut:
    return ProjectFsService(db, project).get_tree()


class ProjectRenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=128)


@router.put("/api/project/name", status_code=200)
def rename_project(
    body: ProjectRenameBody,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> dict:
    renamed = ProjectFsService(db, project).rename_project(body.name)
    _publish_tree_changed(
        project,
        "project.renamed",
        origin_client_id=x_client_id,
        project_id=renamed.id,
        name=renamed.name,
    )
    return {"ok": True}


@router.post("/api/folders", response_model=FolderOut, status_code=201)
def create_folder(
    body: FolderCreateIn,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> FolderOut:
    svc = ProjectFsService(db, project)
    try:
        folder = svc.create_folder(parent_folder_id=body.parent_folder_id, name=body.name)
    except ProjectEntryNameError as e:
        raise HTTPException(400, str(e)) from e
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    _publish_tree_changed(
        project,
        "folder.created",
        origin_client_id=x_client_id,
        folder_id=folder.id,
        parent_folder_id=folder.parent_folder_id,
        name=folder.name,
        folder=_tree_folder_payload(folder),
    )
    return FolderOut.model_validate(folder)


@router.post("/api/docs", response_model=DocOut, status_code=201)
def create_doc(
    body: DocCreateIn,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> DocOut:
    svc = ProjectFsService(db, project)
    try:
        doc = svc.create_doc(
            folder_id=body.folder_id,
            name=body.name,
            format=body.format,
            content=body.content,
        )
    except ProjectEntryNameError as e:
        raise HTTPException(400, str(e)) from e
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    _publish_tree_changed(
        project,
        "doc.created",
        origin_client_id=x_client_id,
        doc_id=doc.id,
        folder_id=doc.folder_id,
        name=doc.name,
        format=doc.format,
        doc=_tree_doc_payload(doc),
    )
    return DocOut.model_validate(doc)


@router.get("/api/docs/{doc_id}", response_model=DocOut)
def get_doc(
    doc_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(get_current_project),
) -> DocOut:
    doc = ProjectFsService(db, project).get_doc(doc_id)
    if doc is None or doc.project_id != project.id:
        raise HTTPException(404, "doc not found")
    return DocOut.model_validate(doc)


@router.get("/api/internal/docs/{doc_id}/content")
def get_doc_content_internal(
    doc_id: str,
    authorization: str | None = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_session),
    user: User | None = Depends(get_optional_current_user),
):
    """Internal endpoint for collab-server to fetch doc content.

    Requires a valid session cookie or document-scoped collab bearer token,
    then checks membership via the doc's project_id.
    """
    doc = db.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(404, "doc not found")
    if user is None:
        token = _bearer_token_from_authorization(authorization)
        record = AuthService(db).verify_collab_token(token, doc_id=doc.id)
        if record is not None:
            user = db.get(User, record.user_id)
    if user is None or user.is_disabled:
        raise HTTPException(401, "Not authenticated")
    if not ProjectMemberService(db).has_access(doc.project_id, user.id):
        raise HTTPException(404, "doc not found")
    return {"content": doc.content, "doc_id": doc.id, "project_id": doc.project_id}


def _bearer_token_from_authorization(authorization: str | None) -> str:
    if not authorization:
        return ""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return ""
    return token.strip()


@router.put("/api/docs/{doc_id}", response_model=DocOut)
def update_doc(
    doc_id: str,
    body: DocUpdateIn,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> DocOut:
    svc = ProjectFsService(db, project)
    existing = svc.get_doc(doc_id)
    if existing is None or existing.project_id != project.id:
        raise HTTPException(404, "doc not found")
    origin = (getattr(body, "origin", None) or "auto_save")
    try:
        doc = svc.update_doc_content(
            doc_id,
            body.content,
            origin=origin,
            actor=str(project.user_id) if project.user_id else None,
            expected_version=body.base_version,
        )
    except DocVersionConflictError as exc:
        current = DocOut.model_validate(exc.current)
        record_collab_event(
            "doc_version_conflict",
            level="warning",
            project_id=project.id,
            doc_id=exc.current.id,
            operation=origin,
            code="doc_version_conflict",
            details={
                "expected_version": body.base_version,
                "current_version": exc.current.version,
                "client_id": x_client_id,
            },
        )
        raise HTTPException(
            status_code=409,
            detail={
                "code": "doc_version_conflict",
                "doc_id": exc.current.id,
                "current_version": exc.current.version,
                "updated_at": current.updated_at.isoformat(),
            },
        ) from exc
    if doc is None:
        raise HTTPException(404, "doc not found")
    out = DocOut.model_validate(doc)
    bus.publish(
        project.id,
        "doc.updated",
        {"doc_id": doc.id, "version": doc.version, "updated_at": out.updated_at.isoformat()},
        origin_client_id=x_client_id,
    )
    return out


@router.post("/api/docs/{doc_id}/collab-flush", response_model=DocOut)
async def flush_collab_doc(
    doc_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> DocOut:
    existing = ProjectFsService(db, project).get_doc(doc_id)
    if existing is None or existing.project_id != project.id:
        raise HTTPException(404, "doc not found")

    try:
        doc = await collab_snapshot_service.snapshot_doc_from_collab(doc_id)
    except collab_snapshot_service.CollabSnapshotError as exc:
        record_collab_event(
            "collab_doc_flush_failed",
            level="error",
            project_id=project.id,
            doc_id=doc_id,
            operation="collab_flush",
            code="collab_flush_failed",
            message=str(exc),
            details={"client_id": x_client_id},
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "collab_flush_failed",
                "message": "Unable to read the current collaboration state",
            },
        ) from exc
    if doc is None:
        record_collab_event(
            "collab_doc_not_ready",
            level="warning",
            project_id=project.id,
            doc_id=doc_id,
            operation="collab_flush",
            code="collab_doc_not_ready",
            details={"client_id": x_client_id},
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "collab_flush_failed",
                "message": "Collaboration state is not ready yet",
            },
        )
    if doc.project_id != project.id:
        raise HTTPException(404, "doc not found")

    out = DocOut.model_validate(doc)
    record_collab_event(
        "collab_doc_flush_succeeded",
        project_id=project.id,
        doc_id=doc.id,
        operation="collab_flush",
        details={"version": doc.version, "client_id": x_client_id},
    )
    bus.publish(
        project.id,
        "doc.updated",
        {"doc_id": doc.id, "version": doc.version, "updated_at": out.updated_at.isoformat()},
        origin_client_id=x_client_id,
    )
    return out


# ---------------------------------------------------------------------------
# A3: rename / delete / upload / export
# ---------------------------------------------------------------------------


class RenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=256)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return validate_project_entry_name(value)


@router.post("/api/entities/{entity_type}/{entity_id}/rename", status_code=200)
def rename_entity(
    entity_type: str,
    entity_id: str,
    body: RenameBody,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> dict:
    if entity_type not in ("folder", "doc", "file"):
        raise HTTPException(400, "entity_type must be folder|doc|file")
    try:
        result = ProjectFsService(db, project).rename_entity_with_format(
            entity_type, entity_id, body.name
        )
    except ProjectEntryNameError as e:
        raise HTTPException(400, str(e)) from e
    if result is False:
        raise HTTPException(404, "entity not found")
    payload: dict[str, object] = {
        "entity_type": entity_type,
        "entity_id": entity_id,
        "name": body.name,
    }
    if isinstance(result, str):
        payload["format"] = result
    _publish_tree_changed(
        project,
        f"{entity_type}.renamed",
        origin_client_id=x_client_id,
        **payload,
    )
    return {"ok": True}


@router.delete("/api/entities/{entity_type}/{entity_id}", status_code=200)
def delete_entity(
    entity_type: str,
    entity_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> dict:
    if entity_type not in ("folder", "doc", "file"):
        raise HTTPException(400, "entity_type must be folder|doc|file")
    count = ProjectFsService(db, project).delete_entity(entity_type, entity_id)
    if count == 0:
        raise HTTPException(404, "entity not found")
    _publish_tree_changed(
        project,
        f"{entity_type}.deleted",
        origin_client_id=x_client_id,
        entity_type=entity_type,
        entity_id=entity_id,
        deleted_count=count,
    )
    return {"ok": True, "deleted_count": count}


class MoveBody(BaseModel):
    target_folder_id: str | None = None


@router.post("/api/entities/{entity_type}/{entity_id}/move", status_code=200)
def move_entity(
    entity_type: str,
    entity_id: str,
    body: MoveBody,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> dict:
    if entity_type not in ("folder", "doc", "file"):
        raise HTTPException(400, "entity_type must be folder|doc|file")
    ok, err = ProjectFsService(db, project).move_entity(entity_type, entity_id, body.target_folder_id)
    if not ok:
        # Cycle / not-found errors → 400 / 404 respectively.
        status = 404 if err and "not found" in err else 400
        raise HTTPException(status, err or "move failed")
    _publish_tree_changed(
        project,
        f"{entity_type}.moved",
        origin_client_id=x_client_id,
        entity_type=entity_type,
        entity_id=entity_id,
        target_folder_id=body.target_folder_id,
    )
    return {"ok": True}



def _publish_tree_changed(
    project: Project,
    action: str,
    *,
    origin_client_id: str = "",
    **payload: object,
) -> None:
    bus.publish(
        project.id,
        "project.tree.changed",
        {
            "action": action,
            **payload,
        },
        origin_client_id=origin_client_id,
    )


@router.post("/api/project/import.zip", status_code=200)
async def import_project_zip(
    file: UploadFile,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> dict:
    blob = await file.read()
    flushed_doc_ids = await flush_project_collab_or_503(project)
    db.expire_all()
    try:
        doc_count, file_count, byte_count = ProjectFsService(db, project).replace_from_zip(
            blob
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    db.expire_all()
    await sync_project_collab_from_db_or_503(
        db,
        project,
        operation="project_import_zip",
    )
    current_doc_ids = {
        str(row[0])
        for row in db.query(Doc.id).filter(Doc.project_id == project.id).all()
    }
    stale_doc_ids = [doc_id for doc_id in flushed_doc_ids if doc_id not in current_doc_ids]
    await invalidate_collab_docs_or_503(
        project,
        stale_doc_ids,
        operation="project_import_zip_stale_doc",
    )
    _publish_tree_changed(
        project,
        "project.imported_zip",
        origin_client_id=x_client_id,
        filename=file.filename or "",
        doc_count=doc_count,
        file_count=file_count,
        byte_count=byte_count,
    )
    return {
        "ok": True,
        "doc_count": doc_count,
        "file_count": file_count,
        "byte_count": byte_count,
    }


@router.post("/api/files/upload", status_code=201)
async def upload_file(
    file: UploadFile,
    folder_id: str | None = Form(None),
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> dict:
    blob = await file.read()
    name = file.filename or "untitled"
    svc = ProjectFsService(db, project)

    # Text-like uploads (decodable, no null bytes) go into `docs` so they can
    # be opened in the editor. Everything else stays a binary FileBlob.
    if is_text_payload(blob):
        content = blob.decode("utf-8", errors="ignore")
        fmt = doc_format_for_name(name)
        try:
            d = svc.create_doc(folder_id=folder_id, name=name, format=fmt, content=content)
        except ProjectEntryNameError as e:
            raise HTTPException(400, str(e)) from e
        except ValueError as e:
            raise HTTPException(404, str(e)) from e
        _publish_tree_changed(
            project,
            "doc.uploaded",
            origin_client_id=x_client_id,
            doc_id=d.id,
            folder_id=d.folder_id,
            name=d.name,
            format=d.format,
            doc=_tree_doc_payload(d),
        )
        return {"ok": True, "kind": "doc", "id": d.id, "format": d.format}

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
    except ProjectEntryNameError as e:
        raise HTTPException(400, str(e)) from e
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    _publish_tree_changed(
        project,
        "file.uploaded",
        origin_client_id=x_client_id,
        file_id=f.id,
        folder_id=f.folder_id,
        name=f.name,
        size_bytes=f.size_bytes,
        mime_type=f.mime_type,
        file=_tree_file_payload(f),
    )
    return {"ok": True, "kind": "file", "id": f.id}


_SAFE_INLINE_MIME_EXACT = {
    "application/pdf",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
}


def _guess_mime(name: str, stored: str) -> str:
    """Upgrade application/octet-stream by filename extension when possible."""
    if stored and stored != "application/octet-stream":
        return stored
    import mimetypes

    guessed, _ = mimetypes.guess_type(name)
    return guessed or stored or "application/octet-stream"


def _is_safe_inline_mime(mime: str) -> bool:
    normalized = (mime or "application/octet-stream").split(";", 1)[0].strip().lower()
    return normalized in _SAFE_INLINE_MIME_EXACT


@router.get("/api/files/{file_id}")
def get_file(
    request: Request,
    file_id: str,
    db: Session = Depends(get_session),
    user: User = Depends(get_current_user),
) -> Response:
    f = db.get(FileBlob, file_id)
    if f is None or not ProjectMemberService(db).has_access(f.project_id, user.id):
        raise HTTPException(404, "file not found")
    mime = _guess_mime(f.name, f.mime_type)
    inline = _is_safe_inline_mime(mime)
    disposition = "inline" if inline else "attachment"
    data = f.blob or b""
    headers = _file_response_headers(f, disposition)
    byte_range = _parse_single_byte_range(request.headers.get("range"), len(data))

    if byte_range is None and _client_cache_is_fresh(request, headers):
        return Response(status_code=304, headers=headers)

    if byte_range is None:
        headers["Content-Length"] = str(len(data))
        return Response(content=data, media_type=mime, headers=headers)

    start, end = byte_range
    chunk = data[start : end + 1]
    headers.update(
        {
            "Content-Range": f"bytes {start}-{end}/{len(data)}",
            "Content-Length": str(len(chunk)),
        }
    )
    return Response(
        content=chunk,
        status_code=206,
        media_type=mime,
        headers=headers,
    )


def _file_response_headers(file: FileBlob, disposition: str) -> dict[str, str]:
    # RFC 5987 filename* for non-ASCII names.
    quoted = quote(file.name)
    updated_at = file.updated_at
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=UTC)
    etag = f'W/"file-{file.id}-{file.size_bytes}-{int(updated_at.timestamp() * 1_000_000)}"'
    return {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0, must-revalidate",
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quoted}",
        "ETag": etag,
        "Last-Modified": format_datetime(updated_at, usegmt=True),
        "X-Content-Type-Options": "nosniff",
    }


def _client_cache_is_fresh(request: Request, headers: dict[str, str]) -> bool:
    if_none_match = request.headers.get("if-none-match")
    if if_none_match:
        requested_etags = {part.strip() for part in if_none_match.split(",")}
        if "*" in requested_etags or headers["ETag"] in requested_etags:
            return True

    if_modified_since = request.headers.get("if-modified-since")
    if if_modified_since:
        try:
            requested_time = parsedate_to_datetime(if_modified_since)
            response_time = parsedate_to_datetime(headers["Last-Modified"])
        except (TypeError, ValueError):
            return False
        if requested_time.tzinfo is None:
            requested_time = requested_time.replace(tzinfo=UTC)
        if response_time.tzinfo is None:
            response_time = response_time.replace(tzinfo=UTC)
        return response_time <= requested_time

    return False


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


@router.post("/api/files/{file_id}/convert-to-doc", response_model=DocOut, status_code=201)
def convert_file_to_doc(
    file_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> DocOut:
    """Migrate a text-like FileBlob (uploaded before the split into docs/files) into `docs`.

    Deletes the original FileBlob on success so the tree stays de-duplicated.
    """
    f = db.get(FileBlob, file_id)
    if f is None or f.project_id != project.id:
        raise HTTPException(404, "file not found")
    raw = f.blob or b""
    # For legacy convert, reject only true binary (null bytes); tolerate invalid
    # UTF-8 sequences (e.g. Latin-1 content) by replacing them.
    if b"\x00" in raw[:8192]:
        raise HTTPException(400, "file is not text and cannot be edited")
    content = raw.decode("utf-8", errors="ignore")
    fmt = doc_format_for_name(f.name)
    svc = ProjectFsService(db, project)
    try:
        doc = svc.create_doc(folder_id=f.folder_id, name=f.name, format=fmt, content=content)
    except ProjectEntryNameError as e:
        raise HTTPException(400, str(e)) from e
    _publish_tree_changed(
        project,
        "file.converted_to_doc",
        origin_client_id=x_client_id,
        file_id=file_id,
        doc_id=doc.id,
        folder_id=doc.folder_id,
        name=doc.name,
        format=doc.format,
        doc=_tree_doc_payload(doc),
    )
    return DocOut.model_validate(doc)


@router.post("/api/files/{file_id}/extract-markdown", response_model=DocOut, status_code=201)
def extract_file_markdown(
    file_id: str,
    db: Session = Depends(get_session),
    project: Project = Depends(require_write_access),
    x_client_id: str = Header(default="", alias="X-Client-Id"),
) -> DocOut:
    """Extract a DOCX/PPTX FileBlob into a sibling Markdown Doc.

    The original FileBlob is preserved.  The new Doc is created in the same
    folder with a non-conflicting ``.md`` name.
    """
    f = db.get(FileBlob, file_id)
    if f is None or f.project_id != project.id:
        raise HTTPException(404, "file not found")

    md_svc = MarkItDownService()
    if not md_svc.is_supported(f.name):
        raise HTTPException(
            400,
            f"Unsupported format: {f.name}. Only .docx and .pptx can be extracted.",
        )

    try:
        result = md_svc.extract_file_blob(f.blob or b"", f.name, f.mime_type)
    except Exception as exc:
        raise HTTPException(500, f"Extraction failed: {exc}") from exc

    svc = ProjectFsService(db, project)
    try:
        safe_name = svc.extracted_markdown_name_for(f.folder_id, f.name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    try:
        doc = svc.create_doc(
            folder_id=f.folder_id,
            name=safe_name,
            format="md",
            content=result.markdown,
        )
    except ProjectEntryNameError as exc:
        raise HTTPException(400, str(exc)) from exc

    _publish_tree_changed(
        project,
        "file.extracted_to_markdown",
        origin_client_id=x_client_id,
        file_id=file_id,
        doc_id=doc.id,
        folder_id=doc.folder_id,
        name=doc.name,
        format=doc.format,
        source_name=f.name,
        doc=_tree_doc_payload(doc),
    )
    return DocOut.model_validate(doc)


def _tree_folder_payload(folder: Folder) -> dict[str, object]:
    return {
        "id": folder.id,
        "name": folder.name,
        "folders": [],
        "docs": [],
        "files": [],
    }


def _tree_doc_payload(doc: Doc) -> dict[str, object]:
    return {
        "id": doc.id,
        "name": doc.name,
        "format": doc.format,
        "size_bytes": len((doc.content or "").encode("utf-8")),
        "updated_at": doc.updated_at.isoformat(),
    }


def _tree_file_payload(file: FileBlob) -> dict[str, object]:
    return {
        "id": file.id,
        "name": file.name,
        "mime_type": file.mime_type,
        "size_bytes": file.size_bytes,
        "updated_at": file.updated_at.isoformat(),
    }


@projects_router.get("/{project_id}/export.zip")
def export_zip(
    db: Session = Depends(get_session),
    project: Project = Depends(get_project_from_path),
) -> Response:
    flush_project_collab_or_503_sync(project)
    db.expire_all()
    try:
        data = ProjectFsService(db, project).export_zip()
    except ProjectEntryNameError as e:
        raise HTTPException(400, str(e)) from e
    safe_name = (project.name or "project").replace('"', "").strip() or "project"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.zip"'},
    )

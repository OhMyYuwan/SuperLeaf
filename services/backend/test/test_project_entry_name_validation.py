from __future__ import annotations

import io
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import filesystem
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import Doc, FileBlob, Folder, Project, User
from app.services.latex_compiler import LatexCompilerService
from app.services.project_fs_service import ProjectFsService


@dataclass(slots=True)
class SeedData:
    owner: User
    project: Project
    folder: Folder
    doc: Doc
    file: FileBlob


@pytest.fixture()
def db() -> Iterator[Session]:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture()
def seed(db: Session) -> SeedData:
    owner = User(id="owner", email="owner@example.com", password_hash="hash", display_name="Owner")
    project = Project(id="project-a", user_id=owner.id, name="Project A")
    folder = Folder(id="folder-a", project_id=project.id, parent_folder_id=None, name="sections")
    doc = Doc(id="doc-a", project_id=project.id, folder_id=None, name="main.tex", content="hello")
    file = FileBlob(
        id="file-a",
        project_id=project.id,
        folder_id=None,
        name="figure.png",
        mime_type="image/png",
        size_bytes=4,
        blob=b"file",
    )
    db.add_all([owner, project, folder, doc, file])
    db.commit()
    return SeedData(owner=owner, project=project, folder=folder, doc=doc, file=file)


@pytest.fixture()
def owner_client(db: Session, seed: SeedData) -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(filesystem.router)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return seed.owner

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize(
    ("method", "url", "json_body"),
    [
        ("post", "/api/folders", {"name": "../sections"}),
        ("post", "/api/docs", {"name": "C:main.tex", "format": "tex", "content": ""}),
        ("post", "/api/entities/doc/doc-a/rename", {"name": " main.tex"}),
    ],
)
def test_filesystem_json_apis_reject_unsafe_entry_names(
    owner_client: TestClient,
    seed: SeedData,
    method: str,
    url: str,
    json_body: dict[str, str],
) -> None:
    response = getattr(owner_client, method)(
        url,
        headers={"X-Project-Id": seed.project.id},
        json=json_body,
    )

    assert response.status_code == 422


def test_upload_rejects_unsafe_filename(owner_client: TestClient, seed: SeedData) -> None:
    response = owner_client.post(
        "/api/files/upload",
        headers={"X-Project-Id": seed.project.id},
        files={"file": ("C:notes.tex", b"hello", "application/x-tex")},
    )

    assert response.status_code == 400


@pytest.mark.parametrize(
    "name",
    [
        "",
        ".",
        "..",
        "../main.tex",
        r"sections\main.tex",
        "C:main.tex",
        " main.tex",
        "main.tex ",
        "bad\x1f.tex",
    ],
)
def test_project_fs_service_rejects_unsafe_created_doc_names(
    db: Session,
    seed: SeedData,
    name: str,
) -> None:
    svc = ProjectFsService(db, seed.project)

    with pytest.raises(ValueError):
        svc.create_doc(folder_id=None, name=name, format="tex", content="unsafe")


def test_project_fs_service_rejects_unsafe_rename_and_upload_names(
    db: Session,
    seed: SeedData,
) -> None:
    svc = ProjectFsService(db, seed.project)

    with pytest.raises(ValueError):
        svc.rename_entity("doc", seed.doc.id, "../renamed.tex")
    with pytest.raises(ValueError):
        svc.upload_file(
            folder_id=None,
            name="bad\x7f.png",
            mime_type="image/png",
            blob=b"unsafe",
        )


def test_project_fs_service_allows_unicode_and_middle_spaces(
    db: Session,
    seed: SeedData,
) -> None:
    svc = ProjectFsService(db, seed.project)

    folder = svc.create_folder(parent_folder_id=None, name="第 1 章")
    doc = svc.create_doc(
        folder_id=folder.id,
        name="章节一 draft.tex",
        format="tex",
        content="safe",
    )
    file = svc.upload_file(
        folder_id=folder.id,
        name="figure draft 1.png",
        mime_type="image/png",
        blob=b"safe",
    )

    assert folder.name == "第 1 章"
    assert doc.name == "章节一 draft.tex"
    assert file.name == "figure draft 1.png"


def test_zip_import_rejects_unsafe_entry_names(db: Session, seed: SeedData) -> None:
    svc = ProjectFsService(db, seed.project)

    with pytest.raises(ValueError):
        svc.replace_from_zip(_zip_bytes({"C:main.tex": b"unsafe"}))


def test_latex_compiler_rejects_legacy_unsafe_names_before_writing(
    db: Session,
    seed: SeedData,
    tmp_path,
) -> None:
    legacy_doc = Doc(
        id="legacy-doc",
        project_id=seed.project.id,
        folder_id=None,
        name="../escape.tex",
        format="tex",
        content="unsafe",
    )
    db.add(legacy_doc)
    db.commit()
    service = LatexCompilerService()

    with pytest.raises(ValueError):
        service._write_project_tree(db, seed.project.id, tmp_path / "compile", seed.doc)

    assert not (tmp_path / "escape.tex").exists()


def _zip_bytes(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, payload in entries.items():
            zf.writestr(name, payload)
    return buf.getvalue()

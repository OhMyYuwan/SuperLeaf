from __future__ import annotations

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
from app.models import Doc, FileBlob, Folder, Project, ProjectMember, User
from app.services.project_fs_service import ProjectFsService


@dataclass(slots=True)
class SeedData:
    owner: User
    viewer: User
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
    viewer = User(id="viewer", email="viewer@example.com", password_hash="hash", display_name="Viewer")
    project = Project(id="project-a", user_id=owner.id, name="Project A")
    folder = Folder(id="folder-a", project_id=project.id, parent_folder_id=None, name="sections")
    doc = Doc(id="doc-a", project_id=project.id, folder_id=None, name="main.tex", content="hello")
    file = FileBlob(
        id="file-a",
        project_id=project.id,
        folder_id=None,
        name="notes.txt",
        mime_type="text/plain",
        size_bytes=5,
        blob=b"hello",
    )
    db.add_all(
        [
            owner,
            viewer,
            project,
            ProjectMember(project_id=project.id, user_id=viewer.id, role="viewer"),
            folder,
            doc,
            file,
        ]
    )
    db.commit()
    return SeedData(owner=owner, viewer=viewer, project=project, folder=folder, doc=doc, file=file)


@pytest.fixture()
def viewer_client(db: Session, seed: SeedData) -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(filesystem.router)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return seed.viewer

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    with TestClient(app) as client:
        yield client


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
    ("method", "url", "kwargs"),
    [
        ("put", "/api/project/name", {"json": {"name": "Renamed"}}),
        ("post", "/api/entities/doc/doc-a/rename", {"json": {"name": "renamed.tex"}}),
        ("delete", "/api/entities/doc/doc-a", {}),
        ("post", "/api/entities/doc/doc-a/move", {"json": {"target_folder_id": "folder-a"}}),
        (
            "post",
            "/api/files/upload",
            {"files": {"file": ("viewer-upload.txt", b"viewer upload", "text/plain")}},
        ),
        ("post", "/api/files/file-a/convert-to-doc", {}),
    ],
)
def test_viewer_cannot_mutate_project_filesystem(
    viewer_client: TestClient,
    seed: SeedData,
    method: str,
    url: str,
    kwargs: dict,
) -> None:
    response = getattr(viewer_client, method)(
        url,
        headers={"X-Project-Id": seed.project.id},
        **kwargs,
    )

    assert response.status_code == 403


def test_project_fs_service_does_not_rename_cross_project_entities(db: Session) -> None:
    project_a, project_b, doc_b, file_b, folder_b = _seed_two_projects(db)
    svc = ProjectFsService(db, project_a)

    assert svc.rename_entity("doc", doc_b.id, "stolen.tex") is False
    assert svc.rename_entity("file", file_b.id, "stolen.png") is False
    assert svc.rename_entity("folder", folder_b.id, "stolen-folder") is False

    db.expire_all()
    assert db.get(Doc, doc_b.id).name == "b.tex"
    assert db.get(FileBlob, file_b.id).name == "b.png"
    assert db.get(Folder, folder_b.id).name == "folder-b"


def test_project_fs_service_does_not_delete_cross_project_entities(db: Session) -> None:
    project_a, project_b, doc_b, file_b, folder_b = _seed_two_projects(db)
    child_doc = Doc(
        id="doc-b-child",
        project_id=project_b.id,
        folder_id=folder_b.id,
        name="child.tex",
        content="child",
    )
    db.add(child_doc)
    db.commit()
    svc = ProjectFsService(db, project_a)

    assert svc.delete_entity("doc", doc_b.id) == 0
    assert svc.delete_entity("file", file_b.id) == 0
    assert svc.delete_entity("folder", folder_b.id) == 0

    db.expire_all()
    assert db.get(Doc, doc_b.id) is not None
    assert db.get(FileBlob, file_b.id) is not None
    assert db.get(Folder, folder_b.id) is not None
    assert db.get(Doc, child_doc.id) is not None


def test_project_fs_service_does_not_update_cross_project_doc_content(db: Session) -> None:
    project_a, _project_b, doc_b, _file_b, _folder_b = _seed_two_projects(db)
    svc = ProjectFsService(db, project_a)

    assert svc.update_doc_content(doc_b.id, "stolen") is None

    db.expire_all()
    assert db.get(Doc, doc_b.id).content == "content b"


def test_convert_file_to_doc_invalid_utf8_skips_bad_bytes(
    db: Session,
    seed: SeedData,
    owner_client: TestClient,
) -> None:
    seed.file.blob = b"prefix \xa3 suffix"
    seed.file.size_bytes = len(seed.file.blob)
    db.commit()

    response = owner_client.post(
        "/api/files/file-a/convert-to-doc",
        headers={"X-Project-Id": seed.project.id},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "notes.txt"
    assert body["content"] == "prefix  suffix"
    db.expire_all()
    assert db.get(Doc, body["id"]).content == "prefix  suffix"


def _seed_two_projects(db: Session) -> tuple[Project, Project, Doc, FileBlob, Folder]:
    owner = User(id="owner-two", email="owner-two@example.com", password_hash="hash")
    project_a = Project(id="project-a2", user_id=owner.id, name="Project A")
    project_b = Project(id="project-b2", user_id=owner.id, name="Project B")
    folder_b = Folder(id="folder-b", project_id=project_b.id, parent_folder_id=None, name="folder-b")
    doc_b = Doc(id="doc-b", project_id=project_b.id, folder_id=None, name="b.tex", content="content b")
    file_b = FileBlob(
        id="file-b",
        project_id=project_b.id,
        folder_id=None,
        name="b.png",
        mime_type="image/png",
        size_bytes=4,
        blob=b"file",
    )
    db.add_all([owner, project_a, project_b, folder_b, doc_b, file_b])
    db.commit()
    return project_a, project_b, doc_b, file_b, folder_b

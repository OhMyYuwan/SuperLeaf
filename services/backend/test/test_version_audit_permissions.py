from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import versions
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import Blob, Doc, DocumentLabel, DocumentVersion, Operation, Project, ProjectMember, User


@dataclass(slots=True)
class SeedData:
    owner: User
    editor: User
    viewer: User
    project: Project
    doc: Doc
    label: DocumentLabel


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
    editor = User(id="editor", email="editor@example.com", password_hash="hash", display_name="Editor")
    viewer = User(id="viewer", email="viewer@example.com", password_hash="hash", display_name="Viewer")
    project = Project(id="project-a", user_id=owner.id, name="Project A")
    doc = Doc(id="doc-a", project_id=project.id, folder_id=None, name="main.tex", content="current")
    blob = Blob(hash="version-one", content=b"version one", byte_length=11, string_length=11)
    version = DocumentVersion(
        id="version-a",
        doc_id=doc.id,
        version=1,
        blob_hash=blob.hash,
        origin="manual",
        actor=owner.id,
    )
    label = DocumentLabel(id="label-a", doc_id=doc.id, version=1, text="baseline")
    db.add_all(
        [
            owner,
            editor,
            viewer,
            project,
            ProjectMember(project_id=project.id, user_id=editor.id, role="editor"),
            ProjectMember(project_id=project.id, user_id=viewer.id, role="viewer"),
            doc,
            blob,
            version,
            label,
        ]
    )
    db.commit()
    return SeedData(owner=owner, editor=editor, viewer=viewer, project=project, doc=doc, label=label)


def make_client(db: Session, user: User) -> TestClient:
    app = FastAPI()
    app.include_router(versions.router)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return user

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    return TestClient(app)


@pytest.mark.parametrize(
    ("method", "url", "kwargs"),
    [
        ("post", "/api/docs/doc-a/restore/1", {}),
        ("post", "/api/docs/doc-a/labels", {"json": {"version": 1, "text": "release"}}),
        ("delete", "/api/docs/doc-a/labels/label-a", {}),
        (
            "post",
            "/api/docs/doc-a/operations",
            {"json": {"type": "accept_suggestion", "payload": {"annotation_id": "ann-a"}}},
        ),
    ],
)
def test_viewer_cannot_mutate_version_history(
    db: Session,
    seed: SeedData,
    method: str,
    url: str,
    kwargs: dict,
) -> None:
    with make_client(db, seed.viewer) as client:
        response = getattr(client, method)(
            url,
            headers={"X-Project-Id": seed.project.id},
            **kwargs,
        )

    assert response.status_code == 403


def test_editor_restore_records_editor_actor(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(versions, "flush_project_collab_or_503_sync", lambda _project: [seed.doc.id])
    monkeypatch.setattr(
        versions,
        "sync_collab_doc_from_db_or_503_sync",
        lambda *_args, **_kwargs: None,
    )

    with make_client(db, seed.editor) as client:
        response = client.post(
            "/api/docs/doc-a/restore/1",
            headers={"X-Project-Id": seed.project.id},
        )

    assert response.status_code == 200
    db.expire_all()
    operation = db.query(Operation).filter(Operation.doc_id == seed.doc.id, Operation.type == "restore").one()
    restored_version = (
        db.query(DocumentVersion)
        .filter(DocumentVersion.doc_id == seed.doc.id, DocumentVersion.origin == "restore")
        .one()
    )
    assert operation.actor == seed.editor.id
    assert restored_version.actor == seed.editor.id


def test_editor_label_and_operation_routes_record_editor_actor(db: Session, seed: SeedData) -> None:
    with make_client(db, seed.editor) as client:
        add_label_response = client.post(
            "/api/docs/doc-a/labels",
            headers={"X-Project-Id": seed.project.id},
            json={"version": 1, "text": "release"},
        )
        assert add_label_response.status_code == 201

        create_operation_response = client.post(
            "/api/docs/doc-a/operations",
            headers={"X-Project-Id": seed.project.id},
            json={"type": "accept_suggestion", "payload": {"annotation_id": "ann-a"}},
        )
        assert create_operation_response.status_code == 201

        remove_label_response = client.delete(
            f"/api/docs/doc-a/labels/{add_label_response.json()['id']}",
            headers={"X-Project-Id": seed.project.id},
        )
        assert remove_label_response.status_code == 204

    db.expire_all()
    operations = {
        row.type: row.actor
        for row in db.query(Operation).filter(Operation.doc_id == seed.doc.id).all()
    }
    assert operations["label_add"] == seed.editor.id
    assert operations["accept_suggestion"] == seed.editor.id
    assert operations["label_remove"] == seed.editor.id

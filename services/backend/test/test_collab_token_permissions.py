from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import auth
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import Doc, Project, ProjectMember, User


@dataclass(slots=True)
class SeedData:
    owner: User
    editor: User
    viewer: User
    project: Project
    editor_member: ProjectMember
    viewer_member: ProjectMember
    doc: Doc


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
    editor_member = ProjectMember(project_id=project.id, user_id=editor.id, role="editor")
    viewer_member = ProjectMember(project_id=project.id, user_id=viewer.id, role="viewer")
    doc = Doc(id="doc-a", project_id=project.id, folder_id=None, name="main.tex", content="hello")
    db.add_all([owner, editor, viewer, project, editor_member, viewer_member, doc])
    db.commit()
    return SeedData(
        owner=owner,
        editor=editor,
        viewer=viewer,
        project=project,
        editor_member=editor_member,
        viewer_member=viewer_member,
        doc=doc,
    )


def make_client(db: Session, user: User) -> TestClient:
    app = FastAPI()
    app.include_router(auth.router)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return user

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    return TestClient(app)


def test_viewer_cannot_get_collaboration_token(db: Session, seed: SeedData) -> None:
    with make_client(db, seed.viewer) as client:
        response = client.get(f"/api/auth/collab-token?doc_id={seed.doc.id}")

    assert response.status_code == 403


def test_editor_can_get_and_verify_collaboration_token(db: Session, seed: SeedData) -> None:
    with make_client(db, seed.editor) as client:
        token_response = client.get(f"/api/auth/collab-token?doc_id={seed.doc.id}")
        assert token_response.status_code == 200
        assert token_response.json()["collab_generation"] == seed.doc.collab_generation

        token = token_response.json()["token"]
        verify_response = client.get(
            f"/api/auth/verify?doc_id={seed.doc.id}",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert verify_response.status_code == 200
    assert verify_response.json()["user_id"] == seed.editor.id
    assert verify_response.json()["collab_generation"] == seed.doc.collab_generation


def test_collaboration_token_fails_after_editor_is_downgraded_to_viewer(
    db: Session,
    seed: SeedData,
) -> None:
    with make_client(db, seed.editor) as client:
        token_response = client.get(f"/api/auth/collab-token?doc_id={seed.doc.id}")
        assert token_response.status_code == 200
        token = token_response.json()["token"]

        seed.editor_member.role = "viewer"
        db.commit()

        verify_response = client.get(
            f"/api/auth/verify?doc_id={seed.doc.id}",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert verify_response.status_code == 403

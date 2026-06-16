from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import filesystem
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import FileBlob, Project, User


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
def owner(db: Session) -> User:
    user = User(id="owner", email="owner@example.com", password_hash="hash", display_name="Owner")
    project = Project(id="project-a", user_id=user.id, name="Project A")
    db.add_all([user, project])
    db.commit()
    return user


@pytest.fixture()
def owner_client(db: Session, owner: User) -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(filesystem.router)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return owner

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize(
    ("name", "mime_type"),
    [
        ("x.html", "text/html"),
        ("x.js", "application/javascript"),
        ("x.svg", "image/svg+xml"),
        ("x.xml", "application/xml"),
        ("x.txt", "text/plain"),
    ],
)
def test_active_uploaded_file_types_are_downloaded_with_nosniff(
    db: Session,
    owner_client: TestClient,
    name: str,
    mime_type: str,
) -> None:
    file_id = f"file-{name}"
    db.add(
        FileBlob(
            id=file_id,
            project_id="project-a",
            folder_id=None,
            name=name,
            mime_type=mime_type,
            size_bytes=27,
            blob=b"<script>alert('xss')</script>",
        )
    )
    db.commit()

    response = owner_client.get(f"/api/files/{file_id}")

    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize(
    ("name", "mime_type"),
    [
        ("figure.png", "image/png"),
        ("paper.pdf", "application/pdf"),
    ],
)
def test_safe_preview_file_types_remain_inline_with_nosniff(
    db: Session,
    owner_client: TestClient,
    name: str,
    mime_type: str,
) -> None:
    file_id = f"file-{name}"
    db.add(
        FileBlob(
            id=file_id,
            project_id="project-a",
            folder_id=None,
            name=name,
            mime_type=mime_type,
            size_bytes=4,
            blob=b"file",
        )
    )
    db.commit()

    response = owner_client.get(f"/api/files/{file_id}")

    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith("inline;")
    assert response.headers["x-content-type-options"] == "nosniff"

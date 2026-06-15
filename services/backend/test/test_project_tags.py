from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import projects
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import User


def test_project_tags_are_normalized_on_create_and_update(client: TestClient) -> None:
    created = client.post(
        "/api/projects",
        json={"name": "Tagged Project", "tags": ["  NLP ", "nlp", "", "Writing"]},
    )

    assert created.status_code == 201
    body = created.json()
    assert body["tags"] == ["NLP", "Writing"]

    updated = client.patch(
        f"/api/projects/{body['id']}",
        json={"tags": [" revision ", "Revision", "实验"]},
    )

    assert updated.status_code == 200
    assert updated.json()["tags"] == ["revision", "实验"]

    listed = client.get("/api/projects")
    assert listed.status_code == 200
    assert listed.json()[0]["tags"] == ["revision", "实验"]


def test_project_tags_can_be_cleared(client: TestClient) -> None:
    created = client.post("/api/projects", json={"name": "Clear Tags", "tags": ["draft"]})
    project_id = created.json()["id"]

    updated = client.patch(f"/api/projects/{project_id}", json={"tags": []})

    assert updated.status_code == 200
    assert updated.json()["tags"] == []


@pytest.fixture()
def client() -> Iterator[TestClient]:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = SessionLocal()
    user = User(id="owner", email="owner@example.com", password_hash="hash", display_name="Owner")
    session.add(user)
    session.commit()

    app = FastAPI()
    app.include_router(projects.router)

    def override_session() -> Iterator[Session]:
        yield session

    def override_user() -> User:
      return user

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user

    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()

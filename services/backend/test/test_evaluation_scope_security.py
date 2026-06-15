from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import annotation_evaluations
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import AnnotationEvaluation, AnnotationReviewState, Doc, Project, ProjectMember, User
from app.services import evaluation_service


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
def seeded(db: Session) -> dict[str, User]:
    owner = User(id="owner", email="owner@example.com", password_hash="hash", display_name="Owner")
    viewer = User(id="viewer", email="viewer@example.com", password_hash="hash", display_name="Viewer")
    project = Project(id="project-a", user_id=owner.id, name="Project A")
    doc = Doc(id="doc-a", project_id=project.id, folder_id=None, name="main.tex", content="hello")
    db.add_all(
        [
            owner,
            viewer,
            project,
            ProjectMember(project_id=project.id, user_id=viewer.id, role="editor"),
            doc,
            AnnotationEvaluation(
                id="eval-owner",
                annotation_id="ann-owner",
                doc_id=doc.id,
                user_id=owner.id,
                target_type="agent",
                target_id="agent-a",
                verdict="negative",
                reason="owner private reason",
                tags=["owner-private"],
                adoption="unknown",
                training_candidate=False,
                context={},
            ),
            AnnotationEvaluation(
                id="eval-viewer",
                annotation_id="ann-viewer",
                doc_id=doc.id,
                user_id=viewer.id,
                target_type="agent",
                target_id="agent-b",
                verdict="positive",
                reason="viewer scoped reason",
                tags=["viewer-tag"],
                adoption="unknown",
                training_candidate=False,
                context={},
            ),
            AnnotationReviewState(
                annotation_id="ann-owner",
                doc_id=doc.id,
                user_id=owner.id,
                status="dismissed",
            ),
            AnnotationReviewState(
                annotation_id="ann-viewer",
                doc_id=doc.id,
                user_id=viewer.id,
                status="addressed",
            ),
        ]
    )
    db.commit()
    return {"owner": owner, "viewer": viewer}


@pytest.fixture()
def viewer_client(db: Session, seeded: dict[str, User]) -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(annotation_evaluations.router)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return seeded["viewer"]

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    with TestClient(app) as client:
        yield client


def test_evaluation_tags_are_scoped_to_current_user(viewer_client: TestClient) -> None:
    response = viewer_client.get(
        "/api/annotations/by-doc/doc-a/evaluation-tags",
        headers={"X-Project-Id": "project-a"},
    )

    assert response.status_code == 200
    assert response.json() == ["viewer-tag"]


def test_review_summary_excludes_other_users_evaluations(db: Session, seeded: dict[str, User]) -> None:
    summary = evaluation_service.review_summary_for_doc(db, "doc-a", user_id=seeded["viewer"].id)

    by_annotation = {entry["annotation_id"]: entry for entry in summary}
    assert set(by_annotation) == {"ann-viewer"}
    assert by_annotation["ann-viewer"]["review_status"] == "addressed"
    assert by_annotation["ann-viewer"]["evaluations"][0]["reason"] == "viewer scoped reason"

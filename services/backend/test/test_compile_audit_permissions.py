from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import compile as compile_api
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import Doc, Project, ProjectMember, User
from app.services.latex_compiler import CompileResult


@dataclass(slots=True)
class SeedData:
    owner: User
    viewer: User
    project: Project
    tex_doc: Doc
    text_doc: Doc
    other_project: Project
    other_tex_doc: Doc


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
    other_project = Project(id="project-b", user_id=owner.id, name="Project B")
    tex_doc = Doc(
        id="doc-tex",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content="\\documentclass{article}\\begin{document}Hi\\end{document}",
    )
    text_doc = Doc(
        id="doc-text",
        project_id=project.id,
        folder_id=None,
        name="notes.txt",
        format="txt",
        content="notes",
    )
    other_tex_doc = Doc(
        id="doc-other",
        project_id=other_project.id,
        folder_id=None,
        name="other.tex",
        format="tex",
        content="other",
    )
    db.add_all(
        [
            owner,
            viewer,
            project,
            other_project,
            ProjectMember(project_id=project.id, user_id=viewer.id, role="viewer"),
            tex_doc,
            text_doc,
            other_tex_doc,
        ]
    )
    db.commit()
    return SeedData(
        owner=owner,
        viewer=viewer,
        project=project,
        tex_doc=tex_doc,
        text_doc=text_doc,
        other_project=other_project,
        other_tex_doc=other_tex_doc,
    )


def make_client(
    db: Session,
    user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> TestClient:
    app = FastAPI()
    app.include_router(compile_api.router)
    fake_service = FakeCompilerService()
    monkeypatch.setattr(compile_api, "get_compiler_service", lambda: fake_service)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return user

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    return TestClient(app)


def make_anonymous_client(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> TestClient:
    app = FastAPI()
    app.include_router(compile_api.router)
    fake_service = FakeCompilerService()
    monkeypatch.setattr(compile_api, "get_compiler_service", lambda: fake_service)

    def override_session() -> Iterator[Session]:
        yield db

    app.dependency_overrides[get_session] = override_session
    return TestClient(app)


def test_compiler_listing_requires_authentication(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with make_anonymous_client(db, monkeypatch) as client:
        response = client.get("/api/compile/compilers")

    assert response.status_code == 401


def test_authenticated_user_can_list_compilers(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with make_client(db, seed.owner, monkeypatch) as client:
        response = client.get("/api/compile/compilers")

    assert response.status_code == 200
    assert response.json() == {"available": ["pdflatex"], "default": "pdflatex"}


def test_compiler_rescan_requires_admin(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with make_client(db, seed.owner, monkeypatch) as client:
        response = client.post("/api/compile/rescan")

    assert response.status_code == 403


def test_admin_can_rescan_compilers(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed.owner.is_admin = True
    with make_client(db, seed.owner, monkeypatch) as client:
        response = client.post("/api/compile/rescan")

    assert response.status_code == 200


def test_viewer_cannot_trigger_fresh_compile(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with make_client(db, seed.viewer, monkeypatch) as client:
        response = client.post(
            "/api/compile",
            headers={"X-Project-Id": seed.project.id},
            json={},
        )

    assert response.status_code == 403


def test_viewer_cannot_update_compile_settings(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with make_client(db, seed.viewer, monkeypatch) as client:
        response = client.put(
            "/api/compile/settings",
            headers={"X-Project-Id": seed.project.id},
            json={"main_doc_id": seed.tex_doc.id},
        )

    assert response.status_code == 403
    db.expire_all()
    assert db.get(Project, seed.project.id).main_doc_id == ""


@pytest.mark.parametrize("endpoint", ["/api/compile", "/api/compile/settings"])
def test_explicit_main_doc_id_must_belong_to_current_project(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
    endpoint: str,
) -> None:
    with make_client(db, seed.owner, monkeypatch) as client:
        request = client.post if endpoint == "/api/compile" else client.put
        response = request(
            endpoint,
            headers={"X-Project-Id": seed.project.id},
            json={"main_doc_id": seed.other_tex_doc.id},
        )

    assert response.status_code == 400


@pytest.mark.parametrize("endpoint", ["/api/compile", "/api/compile/settings"])
def test_explicit_main_doc_id_must_be_tex(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
    endpoint: str,
) -> None:
    with make_client(db, seed.owner, monkeypatch) as client:
        request = client.post if endpoint == "/api/compile" else client.put
        response = request(
            endpoint,
            headers={"X-Project-Id": seed.project.id},
            json={"main_doc_id": seed.text_doc.id},
        )

    assert response.status_code == 400


def test_owner_can_store_valid_tex_main_doc(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with make_client(db, seed.owner, monkeypatch) as client:
        response = client.put(
            "/api/compile/settings",
            headers={"X-Project-Id": seed.project.id},
            json={"main_doc_id": seed.tex_doc.id, "compiler": "pdflatex"},
        )

    assert response.status_code == 200
    assert response.json() == {"main_doc_id": seed.tex_doc.id, "compiler": "pdflatex"}
    db.expire_all()
    project = db.get(Project, seed.project.id)
    assert project.main_doc_id == seed.tex_doc.id
    assert project.compiler == "pdflatex"


class FakeCompilerService:
    available_compilers = ["pdflatex"]

    def rescan_compilers(self) -> None:
        return None

    async def compile_project(
        self,
        db: Session,
        project_id: str,
        *,
        main_doc_id: str | None = None,
        compiler: str | None = None,
    ) -> CompileResult:
        del db, project_id, main_doc_id, compiler
        return CompileResult(
            ok=True,
            pdf=b"%PDF-1.7",
            synctex=None,
            log="",
            error="",
            compiler="pdflatex",
            duration_ms=1,
        )

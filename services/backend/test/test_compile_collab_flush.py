from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import compile as compile_api
from app.api.deps import get_current_user
from app.database import Base, get_session
from app.models import Doc, Project, User
from app.services.latex_compiler import CompileResult


@dataclass(slots=True)
class SeedData:
    owner: User
    project: Project
    tex_doc: Doc


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
    tex_doc = Doc(
        id="doc-tex",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content="\\documentclass{article}\\begin{document}Hi\\end{document}",
    )
    db.add_all([owner, project, tex_doc])
    db.commit()
    return SeedData(owner=owner, project=project, tex_doc=tex_doc)


def make_client(
    db: Session,
    user: User,
    monkeypatch: pytest.MonkeyPatch,
    flush_calls: list[str],
) -> TestClient:
    app = FastAPI()
    app.include_router(compile_api.router)
    monkeypatch.setattr(compile_api, "get_compiler_service", lambda: FakeCompilerService())

    async def fake_flush(project: Project) -> list[str]:
        flush_calls.append(project.id)
        return ["doc-tex"]

    monkeypatch.setattr(compile_api, "flush_project_collab_or_503", fake_flush)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return user

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user
    return TestClient(app)


def test_compile_flushes_collab_project_before_latexmk(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    flush_calls: list[str] = []
    with make_client(db, seed.owner, monkeypatch, flush_calls) as client:
        response = client.post("/api/compile", headers={"X-Project-Id": seed.project.id}, json={})

    assert response.status_code == 200
    assert flush_calls == [seed.project.id]


def test_compile_returns_503_when_collab_flush_fails(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = FastAPI()
    app.include_router(compile_api.router)
    monkeypatch.setattr(compile_api, "get_compiler_service", lambda: FakeCompilerService())

    async def failing_flush(project: Project) -> list[str]:
        raise HTTPException(status_code=503, detail={"code": "collab_flush_failed"})

    monkeypatch.setattr(compile_api, "flush_project_collab_or_503", failing_flush)

    def override_session() -> Iterator[Session]:
        yield db

    def override_user() -> User:
        return seed.owner

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_current_user] = override_user

    with TestClient(app) as client:
        response = client.post("/api/compile", headers={"X-Project-Id": seed.project.id}, json={})

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "collab_flush_failed"


class FakeCompilerService:
    available_compilers = ["pdflatex"]

    async def compile_project(
        self,
        db: Session,
        project_id: str,
        *,
        main_doc_id: str | None = None,
        compiler: str | None = None,
    ) -> CompileResult:
        del db, main_doc_id
        return CompileResult(
            ok=True,
            pdf=b"%PDF-1.7",
            synctex=None,
            log=f"compiled {project_id}",
            error="",
            compiler=compiler or "pdflatex",
            duration_ms=1,
        )

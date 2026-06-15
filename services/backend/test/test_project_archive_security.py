from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import Doc, FileBlob, Folder, Project, User
from app.services.project_archive_service import ArchiveError, ProjectArchiveService


@dataclass(slots=True)
class SeedData:
    owner: User
    project: Project


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
    db.add_all([owner, project])
    db.commit()
    return SeedData(owner=owner, project=project)


def _service(db: Session, seed: SeedData) -> ProjectArchiveService:
    return ProjectArchiveService(db=db, project=seed.project, user=seed.owner)


def _repo_with_live_git(tmp_path: Path) -> Path:
    repo_path = tmp_path / "archive"
    git_dir = repo_path / ".git"
    git_dir.mkdir(parents=True)
    (git_dir / "config").write_text("live git config\n", encoding="utf-8")
    return repo_path


@pytest.mark.parametrize("folder_name", [".git", ".GiT"])
def test_archive_export_rejects_dot_git_folder_before_live_repo_write(
    db: Session,
    seed: SeedData,
    tmp_path: Path,
    folder_name: str,
) -> None:
    folder = Folder(
        id=f"folder-{folder_name}",
        project_id=seed.project.id,
        parent_folder_id=None,
        name=folder_name,
    )
    doc = Doc(
        id=f"doc-{folder_name}",
        project_id=seed.project.id,
        folder_id=folder.id,
        name="config",
        format="tex",
        content="[core]\nmalicious = true\n",
    )
    db.add_all([folder, doc])
    db.commit()
    repo_path = _repo_with_live_git(tmp_path)

    with pytest.raises(ArchiveError, match="Git control"):
        _service(db, seed)._export_project_tree(repo_path)

    assert (repo_path / ".git" / "config").read_text(encoding="utf-8") == "live git config\n"


@pytest.mark.parametrize("doc_name", [".gitattributes", ".gitignore", ".gitmodules"])
def test_archive_export_rejects_git_control_file_names(
    db: Session,
    seed: SeedData,
    tmp_path: Path,
    doc_name: str,
) -> None:
    doc = Doc(
        id=f"doc-{doc_name}",
        project_id=seed.project.id,
        folder_id=None,
        name=doc_name,
        format="tex",
        content="*.tex filter=malicious\n",
    )
    db.add(doc)
    db.commit()
    repo_path = _repo_with_live_git(tmp_path)

    with pytest.raises(ArchiveError, match="Git control"):
        _service(db, seed)._export_project_tree(repo_path)

    assert not (repo_path / doc_name).exists()


def test_archive_export_allows_safe_project_tree(
    db: Session,
    seed: SeedData,
    tmp_path: Path,
) -> None:
    folder = Folder(
        id="folder-sections",
        project_id=seed.project.id,
        parent_folder_id=None,
        name="sections",
    )
    doc = Doc(
        id="doc-main",
        project_id=seed.project.id,
        folder_id=folder.id,
        name="main.tex",
        format="tex",
        content="hello",
    )
    file = FileBlob(
        id="file-figure",
        project_id=seed.project.id,
        folder_id=None,
        name="figure.png",
        mime_type="image/png",
        size_bytes=4,
        blob=b"file",
    )
    db.add_all([folder, doc, file])
    db.commit()
    repo_path = _repo_with_live_git(tmp_path)

    stats = _service(db, seed)._export_project_tree(repo_path)

    assert stats.doc_count == 1
    assert stats.file_count == 1
    assert (repo_path / "sections" / "main.tex").read_text(encoding="utf-8") == "hello"
    assert (repo_path / "figure.png").read_bytes() == b"file"
    assert (repo_path / "SUPERLEAF_ARCHIVE.md").exists()

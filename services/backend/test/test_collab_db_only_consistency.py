from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from sqlalchemy import create_engine, update
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import major_versions, versions
from app.database import Base
from app.models import Blob, Doc, DocumentVersion, Project, ProjectArchiveSnapshot, User
from app.schemas import MajorVersionRestoreIn
from app.services.project_archive_service import CommitDiff
from app.services.project_fs_service import ProjectFsService


def _right_side_text(diff: object) -> str:
    if not isinstance(diff, list):
        return ""
    parts: list[str] = []
    for part in diff:
        if not isinstance(part, dict):
            continue
        if "u" in part:
            parts.append(str(part["u"]))
        if "i" in part:
            parts.append(str(part["i"]))
    return "".join(parts)


@dataclass(slots=True)
class SeedData:
    owner: User
    project: Project
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
    project = Project(id="project-a", user_id=owner.id, name="Project A")
    doc = Doc(
        id="doc-a",
        project_id=project.id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content="STALE\n",
    )
    blob = Blob(
        hash="a" * 40,
        content=b"VERSION\n",
        byte_length=8,
        string_length=8,
    )
    version = DocumentVersion(
        id="version-a",
        doc_id=doc.id,
        version=1,
        blob_hash=blob.hash,
        origin="manual",
        actor=owner.id,
    )
    db.add_all([owner, project, doc, blob, version])
    db.commit()
    return SeedData(owner=owner, project=project, doc=doc)


def test_doc_diff_to_current_flushes_collab_and_expires_session(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_flush(project: Project) -> list[str]:
        calls.append(project.id)
        db.execute(
            update(Doc)
            .where(Doc.id == seed.doc.id)
            .values(content="SYNCED\n")
            .execution_options(synchronize_session=False)
        )
        db.commit()
        return [seed.doc.id]

    monkeypatch.setattr(versions, "flush_project_collab_or_503_sync", fake_flush, raising=False)

    out = versions.get_diff(
        seed.doc.id,
        from_=1,
        to="current",
        db=db,
        project=seed.project,
    )

    assert calls == [seed.project.id]
    assert _right_side_text(out.diff) == "SYNCED\n"


def test_restore_version_flushes_collab_before_overwriting_head(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_flush(project: Project) -> list[str]:
        calls.append(f"flush:{project.id}")
        return [seed.doc.id]

    class RecordingProjectFsService(ProjectFsService):
        def update_doc_content(self, *args, **kwargs) -> Doc | None:
            assert calls == [f"flush:{seed.project.id}"]
            calls.append("restore")
            return super().update_doc_content(*args, **kwargs)

    monkeypatch.setattr(versions, "flush_project_collab_or_503_sync", fake_flush, raising=False)
    monkeypatch.setattr(
        versions,
        "sync_collab_doc_from_db_or_503_sync",
        lambda *_args, **_kwargs: None,
        raising=False,
    )
    monkeypatch.setattr(versions, "ProjectFsService", RecordingProjectFsService)

    out = versions.restore_version(
        seed.doc.id,
        1,
        db=db,
        project=seed.project,
        user=seed.owner,
    )

    assert calls == [f"flush:{seed.project.id}", "restore"]
    assert out.content == "VERSION\n"


def test_restore_version_replaces_collab_doc_after_db_restore(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str]] = []

    def fake_sync(session: Session, project: Project, doc_id: str, *, operation: str) -> None:
        doc = session.get(Doc, doc_id)
        calls.append((operation, doc.content if doc is not None else "missing"))

    monkeypatch.setattr(versions, "flush_project_collab_or_503_sync", lambda _project: [seed.doc.id])
    monkeypatch.setattr(
        versions,
        "sync_collab_doc_from_db_or_503_sync",
        fake_sync,
        raising=False,
    )

    versions.restore_version(
        seed.doc.id,
        1,
        db=db,
        project=seed.project,
        user=seed.owner,
    )

    assert calls == [("version_restore", "VERSION\n")]
    restored_doc = db.get(Doc, seed.doc.id)
    assert restored_doc is not None
    assert restored_doc.collab_generation == 2


def test_major_version_diff_to_current_flushes_collab_before_export(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_flush(project: Project) -> list[str]:
        calls.append(project.id)
        return [seed.doc.id]

    class FakeProjectArchiveService:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def get_commit_diff(self, sha: str, *, against: str | None = None) -> CommitDiff:
            assert sha == "archive-sha"
            assert against is None
            assert calls == [seed.project.id]
            return CommitDiff(
                from_sha=sha,
                to_sha="current",
                files=[],
                total_insertions=0,
                total_deletions=0,
                files_changed=0,
            )

    monkeypatch.setattr(major_versions, "flush_project_collab_or_503_sync", fake_flush)
    monkeypatch.setattr(major_versions, "ProjectArchiveService", FakeProjectArchiveService)

    out = major_versions.get_major_version_diff(
        "archive-sha",
        against=None,
        project=seed.project,
        user=seed.owner,
        db=db,
    )

    assert calls == [seed.project.id]
    assert out.to_sha == "current"


def test_major_version_restore_replaces_project_collab_after_db_restore(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str]] = []

    def fake_sync(session: Session, project: Project, *, operation: str) -> list[str]:
        doc = session.get(Doc, seed.doc.id)
        calls.append((operation, doc.content if doc is not None else "missing"))
        return [seed.doc.id]

    class FakeProjectArchiveService:
        def __init__(self, db: Session, project: Project, user: User) -> None:
            self.db = db
            self.project = project
            self.user = user

        def restore_to_commit(
            self,
            sha: str,
            *,
            message: str | None = None,
        ) -> ProjectArchiveSnapshot:
            assert sha == "archive-sha"
            doc = self.db.get(Doc, seed.doc.id)
            assert doc is not None
            doc.content = "RESTORED\n"
            snapshot = ProjectArchiveSnapshot(
                id="snapshot-a",
                project_id=self.project.id,
                user_id=self.user.id,
                commit_sha="new-sha",
                message=message or "restore",
                doc_count=1,
                file_count=0,
                byte_count=9,
                pushed_to_github=False,
            )
            self.db.add(snapshot)
            self.db.commit()
            return snapshot

    monkeypatch.setattr(major_versions, "flush_project_collab_or_503_sync", lambda _project: [seed.doc.id])
    monkeypatch.setattr(
        major_versions,
        "sync_project_collab_from_db_or_503_sync",
        fake_sync,
        raising=False,
    )
    monkeypatch.setattr(major_versions, "ProjectArchiveService", FakeProjectArchiveService)

    out = major_versions.restore_major_version(
        "archive-sha",
        MajorVersionRestoreIn(message="restore"),
        project=seed.project,
        user=seed.owner,
        db=db,
    )

    assert calls == [("major_version_restore", "RESTORED\n")]
    assert out.commit_sha == "new-sha"


def test_major_version_diff_between_archive_commits_does_not_flush_current_collab(
    db: Session,
    seed: SeedData,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_flush(project: Project) -> list[str]:
        calls.append(project.id)
        return [seed.doc.id]

    class FakeProjectArchiveService:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def get_commit_diff(self, sha: str, *, against: str | None = None) -> CommitDiff:
            assert sha == "head-sha"
            assert against == "base-sha"
            assert calls == []
            return CommitDiff(
                from_sha="base-sha",
                to_sha=sha,
                files=[],
                total_insertions=0,
                total_deletions=0,
                files_changed=0,
            )

    monkeypatch.setattr(major_versions, "flush_project_collab_or_503_sync", fake_flush)
    monkeypatch.setattr(major_versions, "ProjectArchiveService", FakeProjectArchiveService)

    out = major_versions.get_major_version_diff(
        "head-sha",
        against="base-sha",
        project=seed.project,
        user=seed.owner,
        db=db,
    )

    assert calls == []
    assert out.from_sha == "base-sha"

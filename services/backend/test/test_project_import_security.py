from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import Doc, Project, User
from app.services.project_fs_service import ProjectFsService


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


def test_replace_from_directory_skips_symlink_targets(db: Session, tmp_path) -> None:
    user = User(id="owner", email="owner@example.com", password_hash="hash")
    project = Project(id="project-a", user_id=user.id, name="Project A")
    db.add_all([user, project])
    db.commit()

    source = tmp_path / "repo"
    source.mkdir()
    (source / "main.tex").write_text("\\section{Safe}\n", encoding="utf-8")
    secret = tmp_path / "outside-secret.txt"
    secret.write_text("SENTINEL_LOCAL_SECRET", encoding="utf-8")
    (source / "leak.md").symlink_to(secret)

    ProjectFsService(db, project).replace_from_directory(source)

    names = {row.name: row.content for row in db.query(Doc).all()}
    assert names == {"main.tex": "\\section{Safe}\n"}

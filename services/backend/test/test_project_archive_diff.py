from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import Doc, FileBlob, Project, User
from app.services.project_archive_service import ProjectArchiveService
from app.settings import settings


def _db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return session_factory()


def test_commit_diff_defaults_to_current_project_tree(tmp_path):
    old_data_dir = settings.data_dir
    settings.data_dir = tmp_path / "data"
    try:
        db = _db()
        user = User(id="user1", email="user@example.com", password_hash="hash")
        project = Project(id="proj1", user_id=user.id, name="Project")
        doc = Doc(
            id="doc1",
            project_id=project.id,
            folder_id=None,
            name="main.tex",
            format="tex",
            content="old text\n",
        )
        db.add_all([user, project, doc])
        db.commit()

        service = ProjectArchiveService(db, project, user)
        snapshot = service.create_snapshot("initial")

        doc.content = "new text\n"
        db.add(
            FileBlob(
                id="file1",
                project_id=project.id,
                folder_id=None,
                name="notes.txt",
                mime_type="text/plain",
                size_bytes=10,
                blob=b"new notes\n",
            )
        )
        db.commit()

        diff = service.get_commit_diff(snapshot.commit_sha)

        assert diff.from_sha == snapshot.commit_sha
        assert diff.to_sha == "current"

        files = {file.path: file for file in diff.files}
        assert files["main.tex"].status == "M"
        assert "-old text" in (files["main.tex"].patch or "")
        assert "+new text" in (files["main.tex"].patch or "")
        assert files["notes.txt"].status == "A"
        assert files["notes.txt"].insertions == 1
    finally:
        settings.data_dir = old_data_dir

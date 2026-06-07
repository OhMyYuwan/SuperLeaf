from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import Doc, FileBlob, Project, User
from app.services.project_fs_service import DocVersionConflictError, ProjectFsService


def _service():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    db = session_factory()

    user = User(id="user1", email="user@example.com", password_hash="hash")
    project = Project(id="proj1", user_id=user.id, name="Project")
    db.add_all([user, project])
    db.commit()
    return db, project, ProjectFsService(db, project)


def test_create_doc_replaces_same_name_doc_in_same_folder():
    db, _project, service = _service()

    first = service.create_doc(folder_id=None, name="main.tex", format="tex", content="one")
    second = service.create_doc(folder_id=None, name="main.tex", format="tex", content="two")

    docs = db.query(Doc).filter_by(project_id="proj1", folder_id=None, name="main.tex").all()
    assert second.id == first.id
    assert second.content == "two"
    assert second.version == 2
    assert [doc.id for doc in docs] == [first.id]


def test_upload_file_replaces_same_name_doc_in_same_folder():
    db, _project, service = _service()

    service.create_doc(folder_id=None, name="figure.png", format="txt", content="old")
    uploaded = service.upload_file(
        folder_id=None,
        name="figure.png",
        mime_type="image/png",
        blob=b"new",
    )

    docs = db.query(Doc).filter_by(project_id="proj1", folder_id=None, name="figure.png").all()
    files = db.query(FileBlob).filter_by(project_id="proj1", folder_id=None, name="figure.png").all()
    assert docs == []
    assert [file.id for file in files] == [uploaded.id]
    assert files[0].blob == b"new"


def test_create_doc_replaces_same_name_file_in_same_folder():
    db, _project, service = _service()

    service.upload_file(
        folder_id=None,
        name="notes.txt",
        mime_type="text/plain",
        blob=b"old",
    )
    doc = service.create_doc(folder_id=None, name="notes.txt", format="txt", content="new")

    docs = db.query(Doc).filter_by(project_id="proj1", folder_id=None, name="notes.txt").all()
    files = db.query(FileBlob).filter_by(project_id="proj1", folder_id=None, name="notes.txt").all()
    assert [row.id for row in docs] == [doc.id]
    assert files == []
    assert docs[0].content == "new"


def test_update_doc_content_rejects_stale_expected_version():
    db, _project, service = _service()
    doc = service.create_doc(folder_id=None, name="main.tex", format="tex", content="v1")

    first = service.update_doc_content(doc.id, "v2", origin="manual", expected_version=doc.version)

    assert first is not None
    assert first.content == "v2"
    assert first.version == 2

    try:
        service.update_doc_content(doc.id, "stale overwrite", origin="manual", expected_version=1)
    except DocVersionConflictError as exc:
        assert exc.current.id == doc.id
        assert exc.current.version == 2
    else:
        raise AssertionError("expected stale expected_version to be rejected")

    current = db.get(Doc, doc.id)
    assert current is not None
    assert current.content == "v2"
    assert current.version == 2

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.versions import get_diff
from app.database import Base
from app.models import Doc, Project, User
from app.services import version_service


def _db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return session_factory()


def test_doc_diff_can_compare_version_to_current_content():
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

    version_service.snapshot(
        db,
        doc.id,
        doc.content.encode("utf-8"),
        origin="manual",
        actor=user.id,
    )

    doc.content = "new text\n"
    db.commit()

    response = get_diff(doc.id, from_=1, to="current", db=db, project=project)

    assert isinstance(response.diff, list)
    assert any(part.get("d") == "old" for part in response.diff)
    assert any(part.get("i") == "new" for part in response.diff)
    assert any(part.get("u") == " text\n" for part in response.diff)

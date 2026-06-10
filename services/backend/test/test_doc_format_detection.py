from __future__ import annotations

from app.services.project_fs_service import doc_format_for_name, is_text_payload


class TestDocFormatForName:
    def test_tex_extensions_map_to_tex(self) -> None:
        for name in ("main.tex", "ref.bib", "pkg.sty", "doc.latex", "a.ltx", "c.cls", "b.bst"):
            assert doc_format_for_name(name) == "tex", name

    def test_markdown_extensions_map_to_md(self) -> None:
        assert doc_format_for_name("readme.md") == "md"
        assert doc_format_for_name("notes.markdown") == "md"

    def test_txt_extension_maps_to_txt(self) -> None:
        assert doc_format_for_name("notes.txt") == "txt"

    def test_unknown_text_extension_defaults_to_txt(self) -> None:
        assert doc_format_for_name("diagram.tikz") == "txt"
        assert doc_format_for_name("config.cfg") == "txt"
        assert doc_format_for_name("scratch.note") == "txt"

    def test_no_extension_defaults_to_txt(self) -> None:
        assert doc_format_for_name("Makefile") == "txt"

    def test_uppercase_extension_is_normalized(self) -> None:
        assert doc_format_for_name("MAIN.TEX") == "tex"


class TestIsTextPayload:
    def test_plain_utf8_text_is_text(self) -> None:
        assert is_text_payload("hello world\n".encode("utf-8")) is True

    def test_utf8_with_multibyte_chars_is_text(self) -> None:
        assert is_text_payload("中文内容 αβγ\n".encode("utf-8")) is True

    def test_empty_payload_is_text(self) -> None:
        assert is_text_payload(b"") is True

    def test_payload_with_null_byte_is_binary(self) -> None:
        assert is_text_payload(b"PK\x03\x04\x00\x00") is False

    def test_invalid_utf8_is_binary(self) -> None:
        # 0xa3 is a lone continuation byte — invalid UTF-8 start.
        assert is_text_payload(b"\xa3\xa3\xa3") is False

    def test_png_header_is_binary(self) -> None:
        png_magic = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        assert is_text_payload(png_magic) is False

    def test_only_first_8kb_is_inspected(self) -> None:
        # 8KB of valid text, then a null byte beyond the window -> still text.
        payload = (b"a" * 8192) + b"\x00"
        assert is_text_payload(payload) is True


import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import Doc, Project
from app.services.project_fs_service import ProjectFsService


@pytest.fixture()
def db():
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
def project(db: Session) -> Project:
    p = Project(name="p", user_id="u1")
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


class TestRenameRecomputesFormat:
    def test_rename_md_to_tex_updates_format(self, db: Session, project: Project) -> None:
        svc = ProjectFsService(db, project)
        doc = svc.create_doc(folder_id=None, name="a.md", format="md", content="# hi")
        ok = svc.rename_entity("doc", doc.id, "a.tex")
        assert ok is True
        db.refresh(doc)
        assert doc.format == "tex"

    def test_rename_to_unknown_ext_sets_txt(self, db: Session, project: Project) -> None:
        svc = ProjectFsService(db, project)
        doc = svc.create_doc(folder_id=None, name="a.tex", format="tex", content="x")
        svc.rename_entity("doc", doc.id, "a.tikz")
        db.refresh(doc)
        assert doc.format == "txt"

    def test_rename_file_does_not_touch_format(self, db: Session, project: Project) -> None:
        # Files (FileBlob) have no format column; rename must not crash on them.
        from app.models import FileBlob

        f = FileBlob(
            project_id=project.id, folder_id=None, name="img.png",
            mime_type="image/png", size_bytes=3, blob=b"abc",
        )
        db.add(f)
        db.commit()
        svc = ProjectFsService(db, project)
        assert svc.rename_entity("file", f.id, "photo.png") is True


from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.api import filesystem
from app.api.deps import get_current_user
from app.models import User
from app.database import get_session


@pytest.fixture()
def app_client(db: Session):
    _app = FastAPI()
    _app.include_router(filesystem.router)
    _app.dependency_overrides[get_session] = lambda: db
    return _app


@pytest.fixture()
def client(app_client: FastAPI) -> TestClient:
    return TestClient(app_client)


@pytest.fixture()
def user(db: Session) -> User:
    u = User(id="u1", email="test@example.com", password_hash="x")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@pytest.fixture()
def auth_client(app_client: FastAPI, user: User, project: Project, db: Session) -> TestClient:
    from app.models import ProjectMember

    pm = ProjectMember(user_id=user.id, project_id=project.id, role="owner")
    db.add(pm)
    db.commit()

    def override_get_current_user():
        return user

    app_client.dependency_overrides[get_current_user] = override_get_current_user
    return TestClient(app_client)


class TestUploadSplitsByContent:
    def test_unknown_text_ext_uploads_as_doc(self, auth_client: TestClient, project: Project) -> None:
        resp = auth_client.post(
            f"/api/files/upload",
            files={"file": ("diagram.tikz", b"\\draw (0,0);", "text/plain")},
            data={"folder_id": ""},
            headers={"X-Project-Id": project.id},
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["kind"] == "doc"
        assert body["format"] == "txt"

    def test_png_uploads_as_file(self, auth_client: TestClient, project: Project) -> None:
        png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        resp = auth_client.post(
            f"/api/files/upload",
            files={"file": ("x.png", png, "image/png")},
            data={"folder_id": ""},
            headers={"X-Project-Id": project.id},
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["kind"] == "file"

    def test_tex_with_invalid_utf8_uploads_as_file(self, auth_client: TestClient, project: Project) -> None:
        resp = auth_client.post(
            f"/api/files/upload",
            files={"file": ("weird.tex", b"\xa3\xa3\xa3\x00", "application/octet-stream")},
            data={"folder_id": ""},
            headers={"X-Project-Id": project.id},
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["kind"] == "file"


@pytest.fixture()
def make_fileblob(db: Session, project: Project):
    def _make(name: str, blob: bytes) -> str:
        from app.models import FileBlob
        f = FileBlob(
            project_id=project.id,
            folder_id=None,
            name=name,
            mime_type="application/octet-stream",
            size_bytes=len(blob),
            blob=blob,
        )
        db.add(f)
        db.commit()
        db.refresh(f)
        return f.id
    return _make


class TestConvertGuardsBinary:
    def test_convert_binary_blob_rejected(self, auth_client: TestClient, project: Project, make_fileblob) -> None:
        file_id = make_fileblob(name="img.png", blob=b"\x89PNG\r\n\x1a\n\x00\x00")
        resp = auth_client.post(f"/api/files/{file_id}/convert-to-doc", headers={"X-Project-Id": project.id})
        assert resp.status_code == 400
        assert "not text" in resp.json().get("detail", "").lower()

    def test_convert_unknown_text_ext_becomes_txt_doc(self, auth_client: TestClient, project: Project, make_fileblob) -> None:
        file_id = make_fileblob(name="notes.tikz", blob=b"\\draw (1,1);")
        resp = auth_client.post(f"/api/files/{file_id}/convert-to-doc", headers={"X-Project-Id": project.id})
        assert resp.status_code == 201
        assert resp.json()["format"] == "txt"


class TestRenameReturnsFormat:
    def test_rename_returns_new_format_for_doc(self, db: Session, project: Project) -> None:
        svc = ProjectFsService(db, project)
        doc = svc.create_doc(folder_id=None, name="a.md", format="md", content="x")
        result = svc.rename_entity_with_format("doc", doc.id, "a.tex")
        assert result == "tex"

    def test_rename_returns_none_for_file(self, db: Session, project: Project) -> None:
        from app.models import FileBlob

        f = FileBlob(
            project_id=project.id, folder_id=None, name="img.png",
            mime_type="image/png", size_bytes=3, blob=b"abc",
        )
        db.add(f)
        db.commit()
        svc = ProjectFsService(db, project)
        assert svc.rename_entity_with_format("file", f.id, "p.png") is None

    def test_rename_returns_false_sentinel_when_missing(self, db: Session, project: Project) -> None:
        svc = ProjectFsService(db, project)
        assert svc.rename_entity_with_format("doc", "nonexistent", "x.tex") is False


import io
import zipfile


def _make_zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


class TestZipImportSplitsByContent:
    def test_unknown_text_ext_imports_as_doc(self, db: Session, project: Project) -> None:
        svc = ProjectFsService(db, project)
        blob = _make_zip({"main.tex": b"\\documentclass{article}", "fig.tikz": b"\\draw;"})
        svc.replace_from_zip(blob)
        docs = {d.name: d.format for d in db.query(Doc).filter(Doc.project_id == project.id)}
        assert docs.get("fig.tikz") == "txt"
        assert docs.get("main.tex") == "tex"

    def test_binary_in_zip_imports_as_file(self, db: Session, project: Project) -> None:
        from app.models import FileBlob

        svc = ProjectFsService(db, project)
        png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        blob = _make_zip({"main.tex": b"x", "logo.png": png})
        svc.replace_from_zip(blob)
        files = {f.name for f in db.query(FileBlob).filter(FileBlob.project_id == project.id)}
        assert "logo.png" in files

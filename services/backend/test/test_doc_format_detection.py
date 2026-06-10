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

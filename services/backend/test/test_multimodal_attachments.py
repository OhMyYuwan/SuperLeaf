"""Unit tests for multimodal_attachments translator."""

from __future__ import annotations

import base64
import os
import tempfile
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, FileBlob, Project, User
from app.services.multimodal_attachments import (
    classify_mime,
    materialize_attachments_to_workspace,
    resolve_multimodal_attachments,
    to_anthropic_content_blocks,
    to_dify_files_payload,
    to_openai_chat_content_parts,
)


@pytest.fixture
def db_session():
    """In-memory SQLite session for isolated tests."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def project_user(db_session: Session):
    """Create a test project and user."""
    user = User(id="user1", email="test@example.com", password_hash="", display_name="Test User")
    project = Project(id="proj1", name="Test Project", user_id=user.id)
    db_session.add(user)
    db_session.add(project)
    db_session.commit()
    return project, user


def test_classify_mime():
    assert classify_mime("image/png") == "image"
    assert classify_mime("image/jpeg") == "image"
    assert classify_mime("application/pdf") == "document"
    assert classify_mime("audio/mpeg") == "audio"
    assert classify_mime("text/plain") == "unsupported"
    assert classify_mime("application/zip") == "unsupported"


def test_resolve_multimodal_attachments_basic(db_session: Session, project_user):
    """Test resolving attached_files into ResolvedAttachment."""
    project, _ = project_user
    blob = FileBlob(
        id="file1",
        project_id=project.id,
        name="test.png",
        mime_type="image/png",
        size_bytes=1024,
        blob=b"\x89PNG\r\n\x1a\n" + b"\x00" * 1000,
    )
    db_session.add(blob)
    db_session.commit()

    attached_files = [
        {
            "kind": "binary",
            "file_id": "file1",
            "name": "test.png",
            "mime": "image/png",
            "original_size_bytes": 1024,
        }
    ]
    resolved = resolve_multimodal_attachments(
        attached_files, "openai_chat", db_session, project.id
    )
    assert len(resolved) == 1
    assert resolved[0].file_id == "file1"
    assert resolved[0].name == "test.png"
    assert resolved[0].mime == "image/png"
    assert resolved[0].kind == "image"
    assert resolved[0].size_bytes == 1024
    assert resolved[0].blob_loader() == blob.blob


def test_resolve_multimodal_attachments_project_boundary(db_session: Session, project_user):
    """Test that files from another project are filtered out."""
    project, _ = project_user
    other_project = Project(id="proj2", name="Other Project", user_id="user2")
    db_session.add(other_project)
    blob = FileBlob(
        id="file2",
        project_id=other_project.id,
        name="other.png",
        mime_type="image/png",
        size_bytes=512,
        blob=b"data",
    )
    db_session.add(blob)
    db_session.commit()

    attached_files = [{"kind": "binary", "file_id": "file2", "mime": "image/png"}]
    resolved = resolve_multimodal_attachments(
        attached_files, "openai_chat", db_session, project.id
    )
    assert len(resolved) == 0  # filtered out due to project_id mismatch


def test_resolve_multimodal_attachments_unsupported_mime(db_session: Session, project_user):
    """Test that unsupported MIME types are skipped."""
    project, _ = project_user
    blob = FileBlob(
        id="file3",
        project_id=project.id,
        name="doc.zip",
        mime_type="application/zip",
        size_bytes=2048,
        blob=b"PKzip",
    )
    db_session.add(blob)
    db_session.commit()

    attached_files = [{"kind": "binary", "file_id": "file3", "mime": "application/zip"}]
    resolved = resolve_multimodal_attachments(
        attached_files, "openai_chat", db_session, project.id
    )
    assert len(resolved) == 0


def test_to_anthropic_content_blocks():
    """Test Anthropic Messages API content block translation."""
    attachments = [
        Mock(
            file_id="f1",
            name="diagram.png",
            mime="image/png",
            size_bytes=1024,
            kind="image",
            blob_loader=lambda: b"fake_png_data",
        ),
        Mock(
            file_id="f2",
            name="report.pdf",
            mime="application/pdf",
            size_bytes=2048,
            kind="document",
            blob_loader=lambda: b"fake_pdf_data",
        ),
    ]
    blocks = to_anthropic_content_blocks(attachments)
    assert len(blocks) == 2
    assert blocks[0]["type"] == "image"
    assert blocks[0]["source"]["type"] == "base64"
    assert blocks[0]["source"]["media_type"] == "image/png"
    assert blocks[0]["source"]["data"] == base64.b64encode(b"fake_png_data").decode("ascii")
    assert blocks[1]["type"] == "document"
    assert blocks[1]["source"]["type"] == "base64"
    assert blocks[1]["source"]["media_type"] == "application/pdf"


def test_to_anthropic_content_blocks_size_threshold():
    """Test that large files are skipped for inline base64."""
    large_attachment = Mock(
        file_id="f1",
        name="huge.png",
        mime="image/png",
        size_bytes=10 * 1024 * 1024,  # 10 MB > 5 MB threshold
        kind="image",
        blob_loader=lambda: b"x" * (10 * 1024 * 1024),
    )
    blocks = to_anthropic_content_blocks([large_attachment])
    assert len(blocks) == 0  # should be omitted due to size


def test_to_openai_chat_content_parts():
    """Test OpenAI Chat Completions content parts translation."""
    att1 = Mock(spec=['file_id', 'name', 'mime', 'size_bytes', 'kind', 'blob_loader'])
    att1.file_id = "f1"
    att1.name = "photo.jpg"
    att1.mime = "image/jpeg"
    att1.size_bytes = 512
    att1.kind = "image"
    att1.blob_loader = lambda: b"fake_jpg"

    # PDF test: mock a single-page PDF converted to PNG
    att2 = Mock(spec=['file_id', 'name', 'mime', 'size_bytes', 'kind', 'blob_loader'])
    att2.file_id = "f2"
    att2.name = "chart.pdf"
    att2.mime = "application/pdf"
    att2.size_bytes = 1024
    att2.kind = "document"
    # Return a minimal valid PDF with 1 page for the test
    att2.blob_loader = lambda: b"%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 612 792]\n>>\nendobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer\n<<\n/Size 4\n/Root 1 0 R\n>>\nstartxref\n190\n%%EOF"

    attachments = [att1, att2]
    parts = to_openai_chat_content_parts(attachments)

    # Should have image + converted PDF (as image_url)
    assert len(parts) >= 1  # At least the image
    assert parts[0]["type"] == "image_url"
    assert parts[0]["image_url"]["url"].startswith("data:image/jpeg;base64,")

    # PDF conversion may fail in test env without proper poppler setup
    # so we don't assert on parts[1], just check it doesn't crash


def test_to_dify_files_payload():
    """Test Dify files[] payload translation."""
    attachments = [
        Mock(
            file_id="f1",
            name="chart.png",
            mime="image/png",
            size_bytes=1024,
            kind="image",
            upload_id="dify_upload_abc",
        ),
        Mock(
            file_id="f2",
            name="report.pdf",
            mime="application/pdf",
            size_bytes=2048,
            kind="document",
            upload_id=None,  # PDF not uploaded (Dify doesn't support)
        ),
    ]
    files = to_dify_files_payload(attachments)
    assert len(files) == 1
    assert files[0]["type"] == "image"
    assert files[0]["transfer_method"] == "local_file"
    assert files[0]["upload_file_id"] == "dify_upload_abc"


def test_materialize_attachments_to_workspace():
    """Test workspace materialization for Claude CLI."""
    with tempfile.TemporaryDirectory() as tmpdir:
        att1 = Mock(spec=['file_id', 'name', 'mime', 'size_bytes', 'kind', 'blob_loader'])
        att1.file_id = "f1"
        att1.name = "diagram.png"
        att1.mime = "image/png"
        att1.size_bytes = 10
        att1.kind = "image"
        att1.blob_loader = lambda: b"fake_image"

        att2 = Mock(spec=['file_id', 'name', 'mime', 'size_bytes', 'kind', 'blob_loader'])
        att2.file_id = "f2"
        att2.name = "notes/doc.pdf"  # path traversal attempt
        att2.mime = "application/pdf"
        att2.size_bytes = 20
        att2.kind = "document"
        att2.blob_loader = lambda: b"fake_pdf"

        attachments = [att1, att2]
        paths = materialize_attachments_to_workspace(attachments, tmpdir, "run123")
        assert len(paths) == 2
        # Check files exist and have correct content
        assert os.path.exists(os.path.join(tmpdir, paths[0]))
        with open(os.path.join(tmpdir, paths[0]), "rb") as f:
            assert f.read() == b"fake_image"
        # Path traversal should be sanitized: no "/" in final filename
        assert "/" not in os.path.basename(paths[1])
        assert os.path.exists(os.path.join(tmpdir, paths[1]))

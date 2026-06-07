from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.conversations import (
    _build_lease_browser_codex_query,
    _build_light_browser_codex_query,
)
from app.database import Base
from app.models import Doc
from app.schemas import MessageSendIn


def _db_with_doc():
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    db = session_factory()
    db.add(
        Doc(
            id="doc1",
            project_id="proj1",
            folder_id=None,
            name="paper.tex",
            format="tex",
            content="Before. Selected sentence. After.",
        )
    )
    db.commit()
    return db


def _message() -> MessageSendIn:
    return MessageSendIn(
        content="把这段改得更学术。",
        range_start=8,
        range_end=26,
        inputs={
            "target_text": "Selected sentence.",
            "before": "Before.",
            "after": "After.",
            "section_title": "Method",
            "doc_format": "tex",
        },
    )


def test_legacy_browser_codex_prompt_keeps_quick_context():
    db = _db_with_doc()
    payload = _build_light_browser_codex_query(db, SimpleNamespace(document_id="doc1"), _message())
    prompt = payload["agent_query"]

    assert "[SUPERLEAF QUICK CONTEXT]" in prompt
    assert "current_doc_id: doc1" in prompt
    assert "selected_text:" in prompt
    assert "Selected sentence." in prompt
    assert "[CURRENT USER MESSAGE]\n把这段改得更学术。" in prompt


def test_lease_browser_codex_prompt_omits_quick_context_and_selection_payload():
    db = _db_with_doc()
    payload = _build_lease_browser_codex_query(db, SimpleNamespace(document_id="doc1"), _message())
    prompt = payload["agent_query"]

    assert "[SUPERLEAF QUICK CONTEXT]" not in prompt
    assert "current_doc_id:" not in prompt
    assert "selection_range:" not in prompt
    assert "before_selection:" not in prompt
    assert "selected_text:" not in prompt
    assert "after_selection:" not in prompt
    assert "Selected sentence." not in prompt
    assert "[REPLY FORMAT]" in prompt
    assert "[CURRENT USER MESSAGE]\n把这段改得更学术。" in prompt

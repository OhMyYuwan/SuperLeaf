import json

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import Doc, Project, User
from app.services import native_agent_tool_kernel as kernel_module
from app.services.native_agent_tool_kernel import (
    NativeAgentToolContext,
    execute_native_agent_db_tool,
)


def _session_factory():
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with session_factory() as db:
        user = User(id="user1", email="user@example.com", password_hash="hash")
        project = Project(id="proj1", user_id=user.id, name="Paper")
        doc = Doc(
            id="doc1",
            project_id=project.id,
            folder_id=None,
            name="main.tex",
            format="tex",
            content=(
                "\\section{Method}\n"
                "The method is simple.\n"
                "\\subsection{Metrics}\n"
                "Similarity complements divergence.\n"
            ),
        )
        db.add_all([user, project, doc])
        db.commit()
    return session_factory


def _context(**patch: object) -> NativeAgentToolContext:
    data = {
        "project_id": "proj1",
        "user_id": "user1",
        "active_document_id": "doc1",
        "active_range_start": 0,
        "active_range_end": 0,
    }
    data.update(patch)
    return NativeAgentToolContext(**data)


def test_tool_kernel_reads_searches_and_outlines_project_docs(monkeypatch):
    monkeypatch.setattr(kernel_module, "SessionLocal", _session_factory())
    context = _context()

    listed = execute_native_agent_db_tool("project_list_docs", {}, context)
    assert listed is not None
    listed_payload = json.loads(listed.content)
    assert len(listed_payload) == 1
    assert listed_payload[0]["id"] == "doc1"
    assert listed_payload[0]["name"] == "main.tex"
    assert listed_payload[0]["format"] == "tex"
    assert listed_payload[0]["folder_id"] == ""
    assert listed_payload[0]["updated_at"]

    read = execute_native_agent_db_tool(
        "project_read_doc",
        {"doc_id": "doc1", "range_start": 0, "range_end": 22},
        context,
    )
    assert read is not None
    read_payload = json.loads(read.content)
    assert read_payload["content"] == "\\section{Method}\nThe m"
    assert read_payload["range_start"] == 0
    assert read_payload["range_end"] == 22

    grep = execute_native_agent_db_tool("project_grep", {"pattern": "method"}, context)
    assert grep is not None
    grep_payload = json.loads(grep.content)
    assert grep_payload["hits"][0]["doc_id"] == "doc1"
    assert grep_payload["hits"][0]["line"] == 2

    outline = execute_native_agent_db_tool("project_outline", {"doc_id": "doc1"}, context)
    assert outline is not None
    outline_payload = json.loads(outline.content)
    assert outline_payload["sections"][:2] == [
        {"level": 2, "kind": "section", "title": "Method", "offset": 0},
        {"level": 3, "kind": "subsection", "title": "Metrics", "offset": 39},
    ]


def test_tool_kernel_creates_project_file_and_side_event(monkeypatch):
    session_factory = _session_factory()
    monkeypatch.setattr(kernel_module, "SessionLocal", session_factory)
    published: list[tuple[str, str, dict, str]] = []

    def publish(project_id: str, event_type: str, payload: dict, *, origin_client_id: str = "") -> None:
        published.append((project_id, event_type, payload, origin_client_id))

    monkeypatch.setattr(kernel_module.bus, "publish", publish)

    result = execute_native_agent_db_tool(
        "project_write_text_file",
        {"path": "notes/summary.md", "content": "# Summary\n\nDraft.", "format": "md"},
        _context(),
    )

    assert result is not None
    assert result.failed is False
    assert result.tool_kind == "project_write"
    payload = json.loads(result.content)
    assert payload["status"] == "created"
    assert payload["path"] == "notes/summary.md"
    assert result.side_event is not None
    assert result.side_event["event"] == "native.agent.project_file_created"
    assert published[0][0:2] == ("proj1", "project.tree.changed")

    with session_factory() as db:
        created = db.query(Doc).filter_by(project_id="proj1", name="summary.md").one()
        assert created.format == "md"
        assert created.content == "# Summary\n\nDraft."


def test_tool_kernel_creates_edit_proposal_side_event(monkeypatch):
    monkeypatch.setattr(kernel_module, "SessionLocal", _session_factory())

    result = execute_native_agent_db_tool(
        "propose_doc_edit",
        {
            "original_text": "The method is simple.",
            "range_start": 0,
            "range_end": 0,
            "new_text": "The proposed method is concise.",
            "reason": "More precise wording.",
        },
        _context(active_range_start=18),
    )

    assert result is not None
    assert result.failed is False
    assert result.tool_kind == "edit_proposal"
    payload = json.loads(result.content)
    assert payload["status"] == "proposed"
    assert payload["document_id"] == "doc1"
    assert result.side_event is not None
    assert result.side_event["event"] == "native.agent.edit_proposal"
    assert result.side_event["data"]["original_text"] == "The method is simple."
    assert result.side_event["data"]["new_text"] == "The proposed method is concise."


def test_tool_kernel_ignores_non_db_tools():
    assert execute_native_agent_db_tool("use_skill", {}, _context()) is None

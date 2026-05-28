from datetime import UTC, datetime

from app.models import Blob
from app.services.diff_service import compute_diff


def _blob(text: str | bytes, *, created_at: datetime | None = None) -> Blob:
    content = text if isinstance(text, bytes) else text.encode("utf-8")
    try:
        string_length = len(content.decode("utf-8")) if b"\x00" not in content else None
    except UnicodeDecodeError:
        string_length = None
    return Blob(
        hash="test",
        content=content,
        byte_length=len(content),
        string_length=string_length,
        created_at=created_at or datetime(2026, 1, 1, tzinfo=UTC),
    )


def test_compute_diff_keeps_overleaf_shape_for_line_insert():
    diff = compute_diff(_blob("alpha\ncharlie\n"), _blob("alpha\nbravo\ncharlie\n"))

    assert diff == [
        {"u": "alpha\n"},
        {"i": "bravo\n", "meta": {"start_ts": 1767225600000}},
        {"u": "charlie\n"},
    ]


def test_compute_diff_treats_binary_blob_as_binary():
    assert compute_diff(_blob(b"abc\x00def"), _blob("abc")) == {"binary": True}


def test_compute_diff_uses_coarse_replace_for_large_single_line_blocks():
    before = "a" * 7_000
    after = "b" * 7_000

    diff = compute_diff(_blob(before), _blob(after))

    assert diff == [
        {"d": before, "meta": {"start_ts": 1767225600000}},
        {"i": after, "meta": {"start_ts": 1767225600000}},
    ]


def test_compute_diff_handles_repeated_documents_without_full_replace():
    before_lines = ["same latex command \\\\alpha\n"] * 2_000
    after_lines = before_lines.copy()
    after_lines[1_000] = "same latex command \\\\beta\n"
    before = "".join(before_lines)
    after = "".join(after_lines)

    diff = compute_diff(_blob(before), _blob(after))

    assert isinstance(diff, list)
    assert any("d" in part for part in diff)
    assert any("i" in part for part in diff)
    assert any(part.get("i") == "bet" for part in diff)
    changed_chars = sum(len(part.get("d", "")) + len(part.get("i", "")) for part in diff)
    assert changed_chars < 200

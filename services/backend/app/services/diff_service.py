"""Document diff (V3 Phase 3).

Mirrors Overleaf's `diff` shape so the frontend can reuse the highlights
StateField approach: each part is one of `{u: "..."}`, `{i: "...", meta}`, or
`{d: "...", meta}`. Adjacent same-kind parts are merged via `compress_diff`
(Overleaf's `compressDiff` helper).
"""

from __future__ import annotations

from difflib import SequenceMatcher
from typing import Any

from ..models import Blob

# Above this combined byte size, even a cheaper line-level diff creates a very
# large response and CodeMirror document. Degrade gracefully to a single replace
# block instead of spending CPU on detail the UI cannot show comfortably.
MAX_INPUT_BYTES = 500_000

# Character-level refinement is useful for small replacements, but running it
# across large/repetitive blocks is the slow path that made history comparison
# feel stuck. Larger blocks stay line-grained.
MAX_CHAR_REFINEMENT_CHARS = 12_000

# When a large replace block remains after cheap prefix/suffix trimming, only
# spend exact line matching on bounded blocks. Bigger blocks degrade to coarse
# line-grained replace rather than re-entering a quadratic path.
MAX_EXACT_LINE_REFINEMENT_LINES = 2_000


def _decode(blob: Blob) -> str | None:
    if blob.string_length is None:
        return None
    return blob.content.decode("utf-8", errors="ignore")


def compute_diff(blob_a: Blob, blob_b: Blob) -> list[dict[str, Any]] | dict[str, bool]:
    """Return either an Overleaf-shaped diff list or `{"binary": True}` when
    at least one side is non-text.
    """
    text_a = _decode(blob_a)
    text_b = _decode(blob_b)
    if text_a is None or text_b is None:
        return {"binary": True}

    ts_a = int(blob_a.created_at.timestamp() * 1000)
    ts_b = int(blob_b.created_at.timestamp() * 1000)

    if blob_a.byte_length + blob_b.byte_length > MAX_INPUT_BYTES:
        # Degraded fallback: emit a single replace block. Renders cleanly in
        # the frontend (one big strikethrough + one big insertion) without
        # locking up the diff worker.
        parts: list[dict[str, Any]] = []
        if text_a:
            parts.append({"d": text_a, "meta": {"start_ts": ts_a}})
        if text_b:
            parts.append({"i": text_b, "meta": {"start_ts": ts_b}})
        return parts or [{"u": ""}]

    matcher = SequenceMatcher(a=_split_lines(text_a), b=_split_lines(text_b))
    parts: list[dict[str, Any]] = []
    lines_a = matcher.a
    lines_b = matcher.b

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        chunk_a = "".join(lines_a[i1:i2])
        chunk_b = "".join(lines_b[j1:j2])
        if tag == "equal":
            _append_part(parts, "u", chunk_a)
        elif tag == "delete":
            _append_part(parts, "d", chunk_a, ts_a)
        elif tag == "insert":
            _append_part(parts, "i", chunk_b, ts_b)
        elif tag == "replace":
            _append_line_replace(parts, lines_a[i1:i2], lines_b[j1:j2], ts_a, ts_b)
    return compress_diff(parts) or [{"u": ""}]


def _split_lines(text: str) -> list[str]:
    return text.splitlines(keepends=True)


def _append_part(
    parts: list[dict[str, Any]],
    kind: str,
    text: str,
    start_ts: int | None = None,
) -> None:
    if not text:
        return
    part: dict[str, Any] = {kind: text}
    if kind in ("i", "d"):
        part["meta"] = {"start_ts": start_ts}
    parts.append(part)


def _append_line_replace(
    parts: list[dict[str, Any]],
    lines_a: list[str],
    lines_b: list[str],
    ts_a: int,
    ts_b: int,
) -> None:
    prefix = 0
    prefix_limit = min(len(lines_a), len(lines_b))
    while prefix < prefix_limit and lines_a[prefix] == lines_b[prefix]:
        prefix += 1

    if prefix:
        _append_part(parts, "u", "".join(lines_a[:prefix]))

    a_end = len(lines_a)
    b_end = len(lines_b)
    suffix = 0
    suffix_limit = min(a_end - prefix, b_end - prefix)
    while (
        suffix < suffix_limit
        and lines_a[a_end - suffix - 1] == lines_b[b_end - suffix - 1]
    ):
        suffix += 1

    middle_a = lines_a[prefix : a_end - suffix if suffix else a_end]
    middle_b = lines_b[prefix : b_end - suffix if suffix else b_end]
    _append_middle_replace(parts, middle_a, middle_b, ts_a, ts_b)

    if suffix:
        _append_part(parts, "u", "".join(lines_a[a_end - suffix :]))


def _append_middle_replace(
    parts: list[dict[str, Any]],
    lines_a: list[str],
    lines_b: list[str],
    ts_a: int,
    ts_b: int,
) -> None:
    text_a = "".join(lines_a)
    text_b = "".join(lines_b)
    if len(text_a) + len(text_b) <= MAX_CHAR_REFINEMENT_CHARS:
        _append_text_replace(parts, text_a, text_b, ts_a, ts_b)
        return

    if len(lines_a) + len(lines_b) <= MAX_EXACT_LINE_REFINEMENT_LINES:
        matcher = SequenceMatcher(a=lines_a, b=lines_b, autojunk=False)
        opcodes = matcher.get_opcodes()
        if len(opcodes) > 1:
            for tag, i1, i2, j1, j2 in opcodes:
                chunk_a = "".join(lines_a[i1:i2])
                chunk_b = "".join(lines_b[j1:j2])
                if tag == "equal":
                    _append_part(parts, "u", chunk_a)
                elif tag == "delete":
                    _append_part(parts, "d", chunk_a, ts_a)
                elif tag == "insert":
                    _append_part(parts, "i", chunk_b, ts_b)
                elif tag == "replace":
                    _append_text_replace(parts, chunk_a, chunk_b, ts_a, ts_b)
            return

    _append_part(parts, "d", text_a, ts_a)
    _append_part(parts, "i", text_b, ts_b)


def _append_text_replace(
    parts: list[dict[str, Any]],
    text_a: str,
    text_b: str,
    ts_a: int,
    ts_b: int,
) -> None:
    if not text_a:
        _append_part(parts, "i", text_b, ts_b)
        return
    if not text_b:
        _append_part(parts, "d", text_a, ts_a)
        return

    if len(text_a) + len(text_b) > MAX_CHAR_REFINEMENT_CHARS:
        _append_part(parts, "d", text_a, ts_a)
        _append_part(parts, "i", text_b, ts_b)
        return

    matcher = SequenceMatcher(a=text_a, b=text_b)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            _append_part(parts, "u", text_a[i1:i2])
        elif tag == "delete":
            _append_part(parts, "d", text_a[i1:i2], ts_a)
        elif tag == "insert":
            _append_part(parts, "i", text_b[j1:j2], ts_b)
        elif tag == "replace":
            _append_part(parts, "d", text_a[i1:i2], ts_a)
            _append_part(parts, "i", text_b[j1:j2], ts_b)


def _kind(part: dict[str, Any]) -> str | None:
    for k in ("u", "i", "d"):
        if k in part:
            return k
    return None


def compress_diff(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge consecutive same-kind parts. Mirrors Overleaf `compressDiff`.

    For `i`/`d` parts we keep the *earlier* `start_ts` of the merged run, so
    the resulting block represents the moment the change first appeared.
    """
    out: list[dict[str, Any]] = []
    for part in parts:
        kind = _kind(part)
        if not out:
            out.append(dict(part))
            continue
        prev = out[-1]
        prev_kind = _kind(prev)
        if kind != prev_kind or kind is None:
            out.append(dict(part))
            continue
        prev[kind] = (prev[kind] or "") + (part.get(kind) or "")
        if kind in ("i", "d"):
            prev_meta = prev.get("meta") or {}
            new_meta = part.get("meta") or {}
            prev_ts = prev_meta.get("start_ts")
            new_ts = new_meta.get("start_ts")
            if prev_ts is None or (new_ts is not None and new_ts < prev_ts):
                prev_meta["start_ts"] = new_ts if new_ts is not None else prev_ts
            prev["meta"] = prev_meta
    return out

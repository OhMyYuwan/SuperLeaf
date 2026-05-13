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


# Above this combined byte size, SequenceMatcher would risk pathological
# O(n²) blowups; degrade gracefully to a single replace block.
MAX_INPUT_BYTES = 500_000


def _decode(blob: Blob) -> str | None:
    if blob.string_length is None:
        return None
    try:
        return blob.content.decode("utf-8")
    except UnicodeDecodeError:
        return None


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

    matcher = SequenceMatcher(a=text_a, b=text_b, autojunk=False)
    parts: list[dict[str, Any]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            parts.append({"u": text_a[i1:i2]})
        elif tag == "delete":
            parts.append({"d": text_a[i1:i2], "meta": {"start_ts": ts_a}})
        elif tag == "insert":
            parts.append({"i": text_b[j1:j2], "meta": {"start_ts": ts_b}})
        elif tag == "replace":
            parts.append({"d": text_a[i1:i2], "meta": {"start_ts": ts_a}})
            parts.append({"i": text_b[j1:j2], "meta": {"start_ts": ts_b}})
    return compress_diff(parts)


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

"""Text anchor resolution shared by backend Agent command adapters."""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher

EXACT_UNIQUE_CONFIDENCE = 0.98
EXACT_NEAREST_CONFIDENCE = 0.9
FUZZY_WINDOW_RADIUS = 600
FUZZY_TEXT_THRESHOLD = 0.85


@dataclass(frozen=True, slots=True)
class AnchorResolution:
    range_from: int
    range_to: int
    text: str
    anchor_text: str
    status: str
    reason: str
    confidence: float
    candidate_count: int

    def payload(self) -> dict[str, int | str | float]:
        return {
            "range_start": self.range_from,
            "range_end": self.range_to,
            "original_text": self.text,
            "anchor_text": self.anchor_text,
            "anchor_status": self.status,
            "anchor_reason": self.reason,
            "anchor_confidence": self.confidence,
            "anchor_candidate_count": self.candidate_count,
        }


def resolve_text_anchor(
    content: str,
    original_text: str,
    range_start: int,
    range_end: int,
) -> AnchorResolution:
    """Resolve a stale numeric range with the provided text anchor.

    The resolver mirrors the frontend annotation recovery policy: current
    offset match wins, unique exact text wins, nearest exact text wins when
    the hint clearly disambiguates, then a local fuzzy search is attempted.
    """

    safe_start, safe_end = _clamp_range(range_start, range_end, len(content))
    anchor = original_text or ""
    if not anchor:
        return _resolution(
            content,
            safe_start,
            safe_end,
            anchor,
            "offset_only",
            "missing_anchor_text",
            0.0,
            0,
        )

    if content[safe_start:safe_end] == anchor:
        return _resolution(
            content,
            safe_start,
            safe_end,
            anchor,
            "stable",
            "current_range_matches_anchor",
            1.0,
            1,
        )

    exact = _exact_positions(content, anchor)
    if len(exact) == 1:
        start = exact[0]
        return _resolution(
            content,
            start,
            start + len(anchor),
            anchor,
            "recovered",
            "unique_exact_match",
            EXACT_UNIQUE_CONFIDENCE,
            1,
        )

    if len(exact) > 1:
        if safe_start == safe_end:
            return _resolution(
                content,
                safe_start,
                safe_end,
                anchor,
                "needs_review",
                "ambiguous_exact_matches",
                0.5,
                len(exact),
            )
        sorted_positions = sorted(
            exact,
            key=lambda pos: _distance(pos, pos + len(anchor), safe_start, safe_end),
        )
        nearest = sorted_positions[0]
        if len(sorted_positions) == 1:
            clear = True
        else:
            nearest_distance = _distance(nearest, nearest + len(anchor), safe_start, safe_end)
            next_pos = sorted_positions[1]
            next_distance = _distance(next_pos, next_pos + len(anchor), safe_start, safe_end)
            clear = next_distance - nearest_distance >= max(20, len(anchor))
        if clear:
            return _resolution(
                content,
                nearest,
                nearest + len(anchor),
                anchor,
                "recovered",
                "nearest_exact_match",
                EXACT_NEAREST_CONFIDENCE,
                len(exact),
            )
        return _resolution(
            content,
            safe_start,
            safe_end,
            anchor,
            "needs_review",
            "ambiguous_exact_matches",
            0.5,
            len(exact),
        )

    fuzzy = _fuzzy_position(content, anchor, safe_start, safe_end)
    if fuzzy is not None:
        return _resolution(
            content,
            fuzzy,
            min(len(content), fuzzy + len(anchor)),
            anchor,
            "recovered",
            "nearby_fuzzy_match",
            FUZZY_TEXT_THRESHOLD,
            1,
        )

    return _resolution(
        content,
        safe_start,
        safe_end,
        anchor,
        "needs_review",
        "no_confident_match",
        0.0,
        0,
    )


def _resolution(
    content: str,
    start: int,
    end: int,
    anchor: str,
    status: str,
    reason: str,
    confidence: float,
    candidate_count: int,
) -> AnchorResolution:
    safe_start, safe_end = _clamp_range(start, end, len(content))
    return AnchorResolution(
        range_from=safe_start,
        range_to=safe_end,
        text=content[safe_start:safe_end],
        anchor_text=anchor,
        status=status,
        reason=reason,
        confidence=round(float(confidence), 3),
        candidate_count=candidate_count,
    )


def _clamp_range(start: int, end: int, total: int) -> tuple[int, int]:
    safe_start = max(0, min(start, total))
    safe_end = max(safe_start, min(end, total))
    return safe_start, safe_end


def _exact_positions(content: str, anchor: str) -> list[int]:
    positions: list[int] = []
    pos = 0
    while True:
        idx = content.find(anchor, pos)
        if idx == -1:
            return positions
        positions.append(idx)
        pos = idx + 1


def _distance(start: int, end: int, old_start: int, old_end: int) -> int:
    return abs(start - old_start) + abs(end - old_end)


def _fuzzy_position(content: str, anchor: str, old_start: int, old_end: int) -> int | None:
    anchor_len = len(anchor)
    if anchor_len < 8 or not content:
        return None
    search_start = max(0, old_start - FUZZY_WINDOW_RADIUS)
    search_end = min(len(content), old_end + FUZZY_WINDOW_RADIUS)
    if search_end <= search_start:
        return None

    best_ratio = 0.0
    best_pos: int | None = None
    length_delta = max(4, round(anchor_len * 0.25))
    lengths = sorted({anchor_len, max(1, anchor_len - length_delta), anchor_len + length_delta})
    for pos in range(search_start, search_end):
        for length in lengths:
            end = min(len(content), pos + length)
            if end <= pos:
                continue
            ratio = SequenceMatcher(None, _normalize(anchor), _normalize(content[pos:end])).ratio()
            proximity = 1.0 / (1.0 + abs(pos - old_start) / max(1, anchor_len))
            confidence = ratio * 0.7 + proximity * 0.3
            if confidence > best_ratio:
                best_ratio = confidence
                best_pos = pos
    if best_ratio >= FUZZY_TEXT_THRESHOLD:
        return best_pos
    return None


def _normalize(value: str) -> str:
    return " ".join(value.casefold().split())

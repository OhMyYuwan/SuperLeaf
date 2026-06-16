"""Text anchor resolution shared by backend Agent command adapters."""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher

EXACT_UNIQUE_CONFIDENCE = 0.98
EXACT_NEAREST_CONFIDENCE = 0.9
FUZZY_WINDOW_RADIUS = 600
FUZZY_TEXT_THRESHOLD = 0.68


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


@dataclass(frozen=True, slots=True)
class _FuzzyMatch:
    start: int
    end: int
    confidence: float
    candidate_count: int


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
            fuzzy.start,
            fuzzy.end,
            anchor,
            "recovered",
            "nearby_fuzzy_match",
            fuzzy.confidence,
            fuzzy.candidate_count,
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


def _fuzzy_position(content: str, anchor: str, old_start: int, old_end: int) -> _FuzzyMatch | None:
    anchor_len = len(anchor)
    if anchor_len < 8 or not content:
        return None
    search_start = max(0, old_start - FUZZY_WINDOW_RADIUS)
    search_end = min(len(content), old_end + FUZZY_WINDOW_RADIUS)
    if search_end <= search_start:
        return None

    best_confidence = 0.0
    best_start: int | None = None
    best_end: int | None = None
    candidate_count = 0
    min_len = max(4, anchor_len - max(8, round(anchor_len * 0.6)))
    max_len = anchor_len + max(12, round(anchor_len * 1.0))
    starts = _candidate_starts(content, search_start, search_end, old_start)
    ends = _candidate_ends(content, search_start, search_end, old_end)
    normalized_anchor = _normalize(anchor)
    anchor_tokens = normalized_anchor.split()

    for start in starts:
        for end in ends:
            if end <= start:
                continue
            length = end - start
            if length < min_len or length > max_len:
                continue
            candidate = content[start:end].strip()
            if not candidate:
                continue
            confidence = _fuzzy_confidence(
                normalized_anchor,
                anchor_tokens,
                candidate,
                start,
                end,
                old_start,
                old_end,
                anchor_len,
            )
            if confidence >= FUZZY_TEXT_THRESHOLD:
                candidate_count += 1
            if confidence > best_confidence:
                best_confidence = confidence
                best_start = start
                best_end = end
    if best_start is not None and best_end is not None and best_confidence >= FUZZY_TEXT_THRESHOLD:
        return _FuzzyMatch(best_start, best_end, best_confidence, max(1, candidate_count))
    return None


def _normalize(value: str) -> str:
    return " ".join(value.casefold().split())


def _candidate_starts(content: str, search_start: int, search_end: int, old_start: int) -> list[int]:
    starts = {max(search_start, min(old_start, search_end))}
    for pos in range(search_start, search_end):
        if content[pos].isalnum() and (pos == 0 or not content[pos - 1].isalnum()):
            starts.add(pos)
    return sorted(starts)


def _candidate_ends(content: str, search_start: int, search_end: int, old_end: int) -> list[int]:
    ends = {max(search_start, min(old_end, search_end))}
    for pos in range(search_start + 1, search_end + 1):
        if content[pos - 1].isalnum() and (pos == len(content) or not content[pos].isalnum()):
            ends.add(pos)
    return sorted(ends)


def _fuzzy_confidence(
    normalized_anchor: str,
    anchor_tokens: list[str],
    candidate: str,
    start: int,
    end: int,
    old_start: int,
    old_end: int,
    anchor_len: int,
) -> float:
    normalized_candidate = _normalize(candidate)
    if not normalized_candidate:
        return 0.0
    text_ratio = SequenceMatcher(None, normalized_anchor, normalized_candidate).ratio()
    candidate_tokens = normalized_candidate.split()
    token_ratio = SequenceMatcher(None, anchor_tokens, candidate_tokens).ratio() if candidate_tokens else 0.0
    token_coverage = _token_lcs_len(anchor_tokens, candidate_tokens) / max(1, len(anchor_tokens))
    shape_score = max(text_ratio, token_ratio * 0.65 + token_coverage * 0.35)
    proximity = 1.0 / (1.0 + _distance(start, end, old_start, old_end) / max(1, anchor_len))
    return round(shape_score * 0.6 + token_coverage * 0.25 + proximity * 0.15, 3)


def _token_lcs_len(left: list[str], right: list[str]) -> int:
    if not left or not right:
        return 0
    previous = [0] * (len(right) + 1)
    for left_token in left:
        current = [0]
        for idx, right_token in enumerate(right, start=1):
            if left_token == right_token:
                current.append(previous[idx - 1] + 1)
            else:
                current.append(max(previous[idx], current[-1]))
        previous = current
    return previous[-1]

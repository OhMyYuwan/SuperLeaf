"""Text anchor recovery behavior for Agent command writes."""

from __future__ import annotations

from app.agent_commands.anchors import resolve_text_anchor


def test_resolve_text_anchor_recovers_nearby_inserted_phrase_with_actual_span() -> None:
    content = "Intro\nThe final central claim needs much stronger evidence before publication.\n"
    original_text = "final claim needs evidence"
    old_start = content.index("final central claim") + 1
    old_end = old_start + len(original_text)

    resolution = resolve_text_anchor(content, original_text, old_start, old_end)

    assert resolution.status == "recovered"
    assert resolution.reason == "nearby_fuzzy_match"
    assert resolution.text == "final central claim needs much stronger evidence"
    assert resolution.range_from == content.index(resolution.text)
    assert resolution.range_to == resolution.range_from + len(resolution.text)


def test_resolve_text_anchor_recovers_nearby_deleted_phrase_with_actual_span() -> None:
    content = "Intro\nThe final claim has evidence now.\n"
    original_text = "final claim needs stronger evidence"
    old_start = content.index("final claim")
    old_end = old_start + len(original_text)

    resolution = resolve_text_anchor(content, original_text, old_start, old_end)

    assert resolution.status == "recovered"
    assert resolution.reason == "nearby_fuzzy_match"
    assert resolution.text == "final claim has evidence"
    assert resolution.range_from == content.index(resolution.text)
    assert resolution.range_to == resolution.range_from + len(resolution.text)

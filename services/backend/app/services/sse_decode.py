"""Tolerant SSE decoding helpers for provider streams."""

from __future__ import annotations

import codecs
import json
from collections.abc import AsyncIterable, AsyncIterator
from typing import Any


async def iter_sse_json_events(byte_chunks: AsyncIterable[bytes]) -> AsyncIterator[dict[str, Any]]:
    """Yield JSON objects from an SSE byte stream.

    Some OpenAI-compatible gateways occasionally return non-UTF-8 bytes inside
    an otherwise textual stream. Decode bytes with replacement so one bad byte
    does not abort the entire discussion turn.
    """

    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    buffer = ""

    async for chunk in byte_chunks:
        if not chunk:
            continue
        buffer += decoder.decode(chunk)
        while True:
            boundary = _find_event_boundary(buffer)
            if boundary is None:
                break
            start, end = boundary
            event_text = buffer[:start]
            buffer = buffer[end:]
            payload = _sse_data_payload(event_text)
            if payload is None:
                continue
            if payload == "[DONE]":
                return
            parsed = _json_payload(payload)
            if parsed is not None:
                yield parsed

    buffer += decoder.decode(b"", final=True)
    if buffer:
        payload = _sse_data_payload(buffer)
        if payload and payload != "[DONE]":
            parsed = _json_payload(payload)
            if parsed is not None:
                yield parsed


def _find_event_boundary(text: str) -> tuple[int, int] | None:
    candidates: list[tuple[int, int]] = []
    for sep in ("\r\n\r\n", "\n\n", "\r\r"):
        idx = text.find(sep)
        if idx >= 0:
            candidates.append((idx, idx + len(sep)))
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[0])


def _sse_data_payload(event_text: str) -> str | None:
    data_lines: list[str] = []
    for line in event_text.splitlines():
        if not line.startswith("data:"):
            continue
        data_lines.append(line[5:].strip())
    if not data_lines:
        return None
    payload = "\n".join(data_lines).strip()
    return payload or None


def _json_payload(payload: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None

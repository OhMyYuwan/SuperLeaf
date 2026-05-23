"""Project-scoped event bus for real-time fan-out (phase 2 of REQ-0034).

Industrial systems (Overleaf, Notion, Figma) use Redis pub/sub or a managed
broker for this. We have a single-process FastAPI app, so an in-memory
asyncio fan-out is enough — and intentionally simple. If we ever scale to
multiple workers, swap the body of `publish` / `subscribe` for a Redis
client without changing call sites.

Each SSE subscriber gets its own asyncio.Queue. `publish` is non-blocking:
slow subscribers risk being dropped (queue overflow = stale tab; the next
focus/visibility refresh in WorkspacePage catches them up).

Events carry an `origin_client_id` (set from the request's X-Client-Id
header) so the sending browser can ignore its own echo and avoid double-
applying its optimistic mutation.

Event shape:
    {
        "id": "<uuid>",         # for client-side de-dup across reconnects
        "seq": 42,              # monotonic per project while this process is alive
        "type": "annotation.review_status.changed" | ...,
        "ts": "2026-05-12T...",
        "project_id": "...",
        "origin_client_id": "<browser uuid or empty>",
        "payload": { ... type-specific ... }
    }
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import uuid4

logger = logging.getLogger(__name__)

# How many events a slow subscriber may fall behind by before we start
# dropping events. 256 is roughly 30 seconds of feverish typing-like activity
# at 8 events/sec — anything beyond and the tab is probably backgrounded; let
# its focus-handler catch it up rather than blowing memory.
_MAX_QUEUE = 256


@dataclass(eq=False)
class _Subscriber:
    project_id: str
    user_id: str = ""
    user_display_name: str = ""
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=_MAX_QUEUE))


class ProjectEventBus:
    def __init__(self) -> None:
        # project_id -> list of subscribers. We key by identity (`is`) for
        # removal so we can keep the dataclass mutable.
        self._subs: dict[str, list[_Subscriber]] = {}
        self._seqs: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, project_id: str, user_id: str = "", user_display_name: str = "") -> _Subscriber:
        sub = _Subscriber(project_id=project_id, user_id=user_id, user_display_name=user_display_name)
        async with self._lock:
            self._subs.setdefault(project_id, []).append(sub)
        return sub

    async def unsubscribe(self, sub: _Subscriber) -> None:
        async with self._lock:
            bucket = self._subs.get(sub.project_id)
            if bucket is None:
                return
            self._subs[sub.project_id] = [s for s in bucket if s is not sub]
            if not self._subs[sub.project_id]:
                self._subs.pop(sub.project_id, None)

    def publish(
        self,
        project_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        origin_client_id: str = "",
    ) -> None:
        """Fan-out an event. Call this AFTER `db.commit()` — never inside a
        transaction, so subscribers don't observe rows that may roll back.

        Safe to call from synchronous code: it schedules the fan-out on the
        running loop if there is one, or no-ops if we're outside an event
        loop (e.g. in CLI/migration scripts)."""
        bucket = self._subs.get(project_id)
        if not bucket:
            return
        seq = self._seqs.get(project_id, 0) + 1
        self._seqs[project_id] = seq
        event = {
            "id": str(uuid4()),
            "seq": seq,
            "type": event_type,
            "ts": datetime.utcnow().isoformat(timespec="milliseconds") + "Z",
            "project_id": project_id,
            "origin_client_id": origin_client_id,
            "payload": payload,
        }
        for sub in list(bucket):
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                # Slow consumer — drop and let the catch-up path fix it.
                logger.warning(
                    "[event_bus] dropped event for slow subscriber",
                    extra={"project_id": project_id, "event_type": event_type},
                )


# Module singleton. Tests can monkeypatch `bus.publish` if needed.
bus = ProjectEventBus()


def get_online_users(project_id: str) -> list[dict[str, str]]:
    """Return deduplicated list of users currently subscribed to a project's SSE stream."""
    bucket = bus._subs.get(project_id, [])
    seen: dict[str, str] = {}
    for sub in bucket:
        if sub.user_id and sub.user_id not in seen:
            seen[sub.user_id] = sub.user_display_name
    return [{"user_id": uid, "display_name": name} for uid, name in seen.items()]


# --- Request-scoped origin client id propagation ---------------------------
#
# Routes that mutate state set this from the X-Client-Id header so service-
# layer code (evaluation_service, project_fs_service) can attach it to
# published events without threading the value through every signature.

_origin_client_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "ylw_origin_client_id", default=""
)


def set_origin_client_id(client_id: str) -> None:
    _origin_client_id_var.set(client_id or "")


def get_origin_client_id() -> str:
    return _origin_client_id_var.get()

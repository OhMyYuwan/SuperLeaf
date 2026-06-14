"""In-memory MCP session state."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta


@dataclass(slots=True)
class McpSession:
    id: str
    active_project_id: str = ""
    client_name: str = ""
    client_title: str = ""
    client_version: str = ""
    created_at: datetime | None = None
    updated_at: datetime | None = None
    expires_at: datetime | None = None


class McpSessionStore:
    def __init__(self, ttl_seconds: int = 3600, max_sessions: int = 256) -> None:
        self.ttl_seconds = max(60, int(ttl_seconds))
        self.ttl = timedelta(seconds=self.ttl_seconds)
        self.max_sessions = max(1, int(max_sessions))
        self._sessions: dict[str, McpSession] = {}

    def create(self) -> McpSession:
        self.prune()
        now = _utcnow_naive()
        session = McpSession(
            id="mcp_" + secrets.token_hex(12),
            created_at=now,
            updated_at=now,
            expires_at=now + self.ttl,
        )
        self._sessions[session.id] = session
        self._prune_to_max_sessions()
        return session

    def get(self, session_id: str) -> McpSession | None:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        if session.expires_at and session.expires_at < _utcnow_naive():
            self._sessions.pop(session_id, None)
            return None
        now = _utcnow_naive()
        session.updated_at = now
        session.expires_at = now + self.ttl
        return session

    def close(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def prune(self) -> None:
        now = _utcnow_naive()
        for session_id, session in list(self._sessions.items()):
            if session.expires_at and session.expires_at < now:
                self._sessions.pop(session_id, None)

    def status(self) -> dict[str, object]:
        self.prune()
        return {
            "session_count": len(self._sessions),
            "max_sessions": self.max_sessions,
            "ttl_seconds": self.ttl_seconds,
        }

    def _prune_to_max_sessions(self) -> None:
        while len(self._sessions) > self.max_sessions:
            oldest_id = min(
                self._sessions,
                key=lambda session_id: self._sessions[session_id].created_at or _utcnow_naive(),
            )
            self._sessions.pop(oldest_id, None)


def _utcnow_naive() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@dataclass(slots=True)
class McpSseEvent:
    id: str
    stream_id: str
    message: dict[str, object]
    created_at: datetime


class McpEventStore:
    def __init__(self, ttl_seconds: int = 3600, max_per_stream: int = 200) -> None:
        self.ttl = timedelta(seconds=max(60, int(ttl_seconds)))
        self.max_per_stream = max(1, int(max_per_stream))
        self._events: dict[str, McpSseEvent] = {}

    def store_event(self, stream_id: str, message: dict[str, object]) -> McpSseEvent:
        self.prune()
        now = _utcnow_naive()
        event = McpSseEvent(
            id=f"{stream_id}_{int(now.timestamp() * 1000)}_{secrets.token_hex(3)}",
            stream_id=stream_id,
            message=message,
            created_at=now,
        )
        self._events[event.id] = event
        self._prune_stream(stream_id)
        return event

    def stream_id_for_event(self, event_id: str) -> str:
        self.prune()
        event = self._events.get(event_id)
        return event.stream_id if event else ""

    def replay_after(self, event_id: str) -> list[McpSseEvent]:
        self.prune()
        event = self._events.get(event_id)
        if event is None:
            return []
        stream_id = event.stream_id
        events = sorted(self._events.values(), key=lambda item: item.id)
        found = False
        replay: list[McpSseEvent] = []
        for item in events:
            if item.stream_id != stream_id:
                continue
            if item.id == event_id:
                found = True
                continue
            if found:
                replay.append(item)
        return replay

    def prune(self) -> None:
        cutoff = _utcnow_naive() - self.ttl
        for event_id, event in list(self._events.items()):
            if event.created_at < cutoff:
                self._events.pop(event_id, None)

    def _prune_stream(self, stream_id: str) -> None:
        stream_events = sorted(
            (event for event in self._events.values() if event.stream_id == stream_id),
            key=lambda item: item.id,
        )
        for event in stream_events[: max(0, len(stream_events) - self.max_per_stream)]:
            self._events.pop(event.id, None)

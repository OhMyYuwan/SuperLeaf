"""Backend runner for project-scoped native Agents.

The runner intentionally receives only explicit payload data assembled by
YuwanLabWriter. It has no database/session handle and no filesystem access.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from .attached_files import render_attached_files_block
from .nanobot_client import NanobotClient


@dataclass(slots=True)
class NativeSkillBlock:
    name: str
    version: int
    source: str
    content: str


@dataclass(slots=True)
class NativeAgentRuntimeConfig:
    agent_id: str
    agent_name: str
    provider_endpoint: str
    api_key: str
    model: str
    instructions: str
    skills: list[NativeSkillBlock] = field(default_factory=list)
    temperature: float = 0.2
    max_tokens: int = 4000


@dataclass(slots=True)
class NativeRunPayload:
    document_id: str
    range_start: int
    range_end: int
    inputs: dict[str, Any]
    query: str = ""
    conversation_id: str = ""
    context_files: list[dict[str, Any]] = field(default_factory=list)


class NativeAgentRunner:
    def __init__(self, config: NativeAgentRuntimeConfig) -> None:
        self.config = config

    async def stream(self, payload: NativeRunPayload) -> AsyncIterator[dict[str, Any]]:
        client = NanobotClient(
            endpoint=self.config.provider_endpoint,
            api_key=self.config.api_key,
            timeout=30.0,
        )
        system_prompt = self._system_prompt()
        user_prompt = self._user_prompt(payload)
        session_id = payload.conversation_id or None

        yield {
            "event": "native.agent.step",
            "data": {
                "agent_id": self.config.agent_id,
                "agent_name": self.config.agent_name,
                "model": self.config.model,
                "skill_count": len(self.config.skills),
            },
        }

        async for evt in client.run_streaming(
            model=self.config.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            session_id=session_id,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
        ):
            delta = _delta_text(evt)
            yield {
                "event": "native.agent.raw",
                "data": evt,
            }
            if delta:
                yield {
                    "event": "native.agent.output.delta",
                    "data": {"delta": delta},
                }

    def _system_prompt(self) -> str:
        parts = [
            "You are a native YuwanLabWriter Agent.",
            "You must only use the context explicitly provided in the user message.",
            "Do not claim to have read project files, folders, or databases.",
            "Do not propose direct file mutations. Return review output only.",
        ]
        if self.config.instructions.strip():
            parts.extend(["", "Agent instructions:", self.config.instructions.strip()])
        if self.config.skills:
            parts.append("")
            parts.append("Enabled Skills:")
            for skill in self.config.skills:
                parts.append(f"\n--- Skill: {skill.name} v{skill.version} ({skill.source}) ---")
                parts.append(skill.content.strip())
        parts.extend(
            [
                "",
                "When producing annotations, prefer JSON with keys annotations, suggestions, risks.",
                "If free-form output is more appropriate, keep it concise and actionable.",
            ]
        )
        return "\n".join(part for part in parts if part is not None).strip()

    def _user_prompt(self, payload: NativeRunPayload) -> str:
        inputs = payload.inputs or {}
        selection_text = str(inputs.get("target_text") or payload.query or "").strip()
        instruction = str(inputs.get("instruction") or payload.query or "").strip()
        before = str(inputs.get("before") or "").strip()
        after = str(inputs.get("after") or "").strip()
        section_title = str(inputs.get("section_title") or "").strip()
        attached_files = inputs.get("attached_files")
        if not isinstance(attached_files, list):
            attached_files = payload.context_files

        parts: list[str] = [
            f"Document id: {payload.document_id}",
            f"Selected range: {payload.range_start}-{payload.range_end}",
        ]
        if section_title:
            parts.append(f"Section: {section_title}")
        if instruction:
            parts.extend(["", "User instruction:", instruction])
        if selection_text:
            parts.extend(["", "Selected text:", selection_text])
        if before or after:
            parts.append("")
            parts.append("Surrounding context:")
            if before:
                parts.append(f"Before: {before}")
            if after:
                parts.append(f"After: {after}")
        file_block = render_attached_files_block(attached_files)
        if file_block:
            parts.extend(["", file_block])
        return "\n".join(parts).strip()


def _delta_text(evt: dict[str, Any]) -> str:
    choices = evt.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if isinstance(delta, dict) and isinstance(delta.get("content"), str):
        return delta["content"]
    message = first.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return message["content"]
    text = first.get("text")
    return text if isinstance(text, str) else ""

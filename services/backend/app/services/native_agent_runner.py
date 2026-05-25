"""Backend runner for project-scoped native Agents.

The runner intentionally receives only explicit payload data assembled by
YuwanLabWriter. It has no database/session handle and no filesystem access.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any

from .attached_files import render_attached_files_block
from .agent_workspace_service import (
    AgentWorkspaceError,
    list_agent_workspace_files,
    read_agent_workspace_file,
)
from .mcp_tool_service import McpToolRef, call_mcp_tool, discover_mcp_tools
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
    workspace_root: str = ""
    temperature: float = 0.2
    max_tokens: int = 4000
    max_tool_rounds: int = 8
    runtime_config: dict[str, Any] = field(default_factory=dict)


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
        system_prompt = self._system_prompt(payload)
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

        if self.config.workspace_root:
            async for evt in self._stream_with_workspace_tools(client, system_prompt, user_prompt, session_id):
                yield evt
            return

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

    def _system_prompt(self, payload: NativeRunPayload | None = None) -> str:
        inputs = (payload.inputs if payload else {}) or {}
        write_mode = str(inputs.get("write_mode") or "").strip()
        legacy_output_mode = str(inputs.get("automation_output_mode") or "").strip()
        is_write_mode = bool(write_mode) or legacy_output_mode == "write"

        parts = [
            "You are a native YuwanLabWriter Agent.",
            "You must only use the user message and your assigned Agent workspace.",
            "Your only readable workspace is `.agents/` for this Agent.",
            "Use list_agent_files and read_agent_file when you need Skill files.",
            "Never claim to read files outside `.agents/`.",
            "If MCP tools are available, call them only when the user explicitly asks for external retrieval, academic search, paper lookup, citation lookup, or source-backed evidence.",
            "Do not use MCP tools for ordinary editing, rewriting, style review, or summarization unless the user asks to search or verify external sources.",
        ]
        if not is_write_mode:
            parts.append("Do not propose direct file mutations. Return review output only.")
        if self.config.instructions.strip():
            parts.extend(["", "Agent instructions:", self.config.instructions.strip()])
        if self.config.skills:
            parts.append("")
            parts.append("Enabled Skills:")
            for skill in self.config.skills:
                parts.append(f"\n--- Skill: {skill.name} v{skill.version} ({skill.source}) ---")
                parts.append(skill.content.strip())
        if is_write_mode:
            doc_format = str(inputs.get("doc_format") or "").strip().lower()
            fence_lang = "latex" if doc_format == "tex" else ("markdown" if doc_format == "md" else "text")
            parts.extend(
                [
                    "",
                    "Output mode: WRITE. The user has requested direct text output that will be written into the document.",
                    f"Wrap the full target text in a fenced code block: ```{fence_lang} ... ```",
                    "Do NOT output JSON, do NOT output annotation cards, do NOT add explanation outside the fence.",
                    "If the user message contains [PRE-EXISTING TEXT], preserve its preamble, style, and indentation; modify only what the user instruction asks.",
                ]
            )
            if doc_format == "tex":
                parts.extend(
                    [
                        "",
                        "TARGET FORMAT: LaTeX (.tex).",
                        "- Use LaTeX commands: \\section{...}, \\subsection{...}, \\textbf{...}, \\emph{...}, \\cite{key}, \\ref{label}, inline math $...$, display math \\[...\\] or equation environment, lists via itemize/enumerate.",
                        "- DO NOT use Markdown syntax: no `# heading`, no `**bold**`, no `*italic*`, no `- bullet` outside itemize, no `[text](url)`, no inner triple-backtick code fences (the only fence is the outermost output fence).",
                        "- Preserve every existing \\command{...} and citation key verbatim. Do not rewrite \\cite{X} as [X].",
                        "- Escape LaTeX special characters correctly when they appear as text: % & _ # $ { }.",
                    ]
                )
            elif doc_format == "md":
                parts.extend(
                    [
                        "",
                        "TARGET FORMAT: Markdown (.md).",
                        "- Use Markdown syntax: `# heading`, `**bold**`, `*italic*`, `-` / `1.` lists, `[text](url)`, inline code with backticks.",
                        "- DO NOT use LaTeX commands such as \\section, \\textbf, \\cite, \\ref. If the source has math, keep it as `$...$` or `$$...$$`.",
                        "- If you need a nested code block inside the output, use `~~~` or more backticks to avoid colliding with the outer ``` fence.",
                    ]
                )
            else:
                parts.extend(
                    [
                        "",
                        "TARGET FORMAT: Plain text (.txt).",
                        "- Output plain prose only — no LaTeX commands, no Markdown syntax. Use blank lines between paragraphs.",
                    ]
                )
        else:
            parts.extend(
                [
                    "",
                    "Return a direct Markdown response that can be rendered as-is in YuwanLabWriter.",
                    "Do NOT output JSON or split the answer into annotations, suggestions, or risks unless the user or workflow explicitly asks for that structured schema.",
                    "If you include replaceable text, put that snippet in one fenced code block and keep its source format from the user's selected text.",
                    "Keep the review concise, actionable, and anchored to the selected text.",
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

    async def _stream_with_workspace_tools(
        self,
        client: NanobotClient,
        system_prompt: str,
        user_prompt: str,
        session_id: str | None,
    ) -> AsyncIterator[dict[str, Any]]:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        mcp_refs = await discover_mcp_tools(self.config.runtime_config)
        mcp_tool_map = {ref.function_name: ref for ref in mcp_refs}
        tools = _workspace_tools() + [ref.definition for ref in mcp_refs]

        for _round in range(max(1, self.config.max_tool_rounds)):
            tool_acc = _ToolAccumulator()
            content_parts: list[str] = []
            async for evt in client.run_streaming(
                model=self.config.model,
                messages=messages,
                session_id=session_id,
                temperature=self.config.temperature,
                max_tokens=self.config.max_tokens,
                tools=tools,
                tool_choice="auto",
            ):
                delta = _delta_text(evt)
                if delta:
                    content_parts.append(delta)
                tool_acc.add_event(evt)
                yield {"event": "native.agent.raw", "data": evt}
                if delta:
                    yield {"event": "native.agent.output.delta", "data": {"delta": delta}}

            tool_calls = tool_acc.calls()
            if not tool_calls:
                return

            assistant_message: dict[str, Any] = {
                "role": "assistant",
                "content": "".join(content_parts) or None,
                "tool_calls": tool_calls,
            }
            messages.append(assistant_message)
            for call in tool_calls:
                result = await self._execute_tool(call, mcp_tool_map)
                yield {
                    "event": "native.agent.tool",
                    "data": {
                        "name": call.get("function", {}).get("name", ""),
                        "result_preview": result[:500],
                    },
                }
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id") or "tool-call",
                        "content": result,
                    }
                )

        yield {
            "event": "native.agent.output.delta",
            "data": {"delta": "\n\n[Tool limit reached while reading Agent workspace.]"},
        }

    async def _execute_tool(self, call: dict[str, Any], mcp_tool_map: dict[str, McpToolRef]) -> str:
        fn = call.get("function") if isinstance(call.get("function"), dict) else {}
        name = str(fn.get("name") or "")
        args_raw = fn.get("arguments") or "{}"
        try:
            args = json.loads(args_raw) if isinstance(args_raw, str) else dict(args_raw)
        except (TypeError, ValueError):
            args = {}
        root = Path(self.config.workspace_root)
        try:
            if name == "list_agent_files":
                prefix = str(args.get("prefix") or ".agents")
                files = list_agent_workspace_files(root, prefix=prefix)
                return json.dumps(
                    [{"path": file.path, "type": file.type, "size": file.size} for file in files],
                    ensure_ascii=False,
                )
            if name == "read_agent_file":
                path = str(args.get("path") or "")
                content = read_agent_workspace_file(root, path)
                return content
            if name in mcp_tool_map:
                return await call_mcp_tool(mcp_tool_map[name], args)
        except AgentWorkspaceError as exc:
            return f"ERROR: {exc}"
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {type(exc).__name__}: {exc}"
        return f"ERROR: unknown tool {name}"


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


def _workspace_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "list_agent_files",
                "description": "List files and folders in this Agent's read-only .agents workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prefix": {
                            "type": "string",
                            "description": "Path under .agents, for example .agents or .agents/skills.",
                        }
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_agent_file",
                "description": "Read a safe text file from this Agent's read-only .agents workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path under .agents, for example .agents/skills/name/SKILL.md.",
                        }
                    },
                    "required": ["path"],
                },
            },
        },
    ]


class _ToolAccumulator:
    def __init__(self) -> None:
        self._calls: dict[int, dict[str, Any]] = {}

    def add_event(self, evt: dict[str, Any]) -> None:
        choices = evt.get("choices")
        if not isinstance(choices, list):
            return
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if isinstance(message, dict):
                self._add_tool_calls(message.get("tool_calls"))
            delta = choice.get("delta")
            if isinstance(delta, dict):
                self._add_tool_calls(delta.get("tool_calls"))

    def _add_tool_calls(self, raw_calls: Any) -> None:
        if not isinstance(raw_calls, list):
            return
        for fallback_index, raw in enumerate(raw_calls):
            if not isinstance(raw, dict):
                continue
            index = int(raw.get("index") if raw.get("index") is not None else fallback_index)
            current = self._calls.setdefault(
                index,
                {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
            )
            if raw.get("id"):
                current["id"] = raw["id"]
            if raw.get("type"):
                current["type"] = raw["type"]
            fn = raw.get("function")
            if isinstance(fn, dict):
                current_fn = current.setdefault("function", {"name": "", "arguments": ""})
                if fn.get("name"):
                    current_fn["name"] = str(current_fn.get("name") or "") + str(fn["name"])
                if fn.get("arguments"):
                    current_fn["arguments"] = str(current_fn.get("arguments") or "") + str(fn["arguments"])

    def calls(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for index in sorted(self._calls):
            call = self._calls[index]
            fn = call.get("function") if isinstance(call.get("function"), dict) else {}
            if not fn.get("name"):
                continue
            if not call.get("id"):
                call["id"] = f"tool-call-{index}"
            out.append(call)
        return out

"""Backend runner for project-scoped native Agents.

The runner intentionally receives only explicit payload data assembled by
SuperLeaf. Project tools are scoped by project_id/user_id and write through the
same SQLite-backed project tree services as the REST API; Agents never receive
raw filesystem access.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from typing import Any

from ..database import SessionLocal
from ..models import Doc, FileBlob, Folder, Project
from .agent_workspace_service import (
    AgentWorkspaceError,
    list_agent_workspace_files,
    read_agent_workspace_file,
)
from .attached_files import render_attached_files_block
from .event_bus import bus
from .mcp_tool_service import McpToolRef, call_mcp_tool, discover_mcp_tools
from .nanobot_client import NanobotClient
from .project_fs_service import ProjectFsService
from .project_member_service import ProjectMemberService

_PROJECT_CREATE_CONTENT_LIMIT = 512 * 1024
_PROJECT_CREATE_MAX_PATH_CHARS = 512
_PROJECT_CREATE_MAX_SEGMENT_CHARS = 256
_PROJECT_CREATE_DOC_EXTS: dict[str, str] = {
    "tex": "tex",
    "latex": "tex",
    "ltx": "tex",
    "bib": "tex",
    "sty": "tex",
    "cls": "tex",
    "bst": "tex",
    "md": "md",
    "markdown": "md",
    "txt": "txt",
}
_BROWSER_NANOBOT_TOOL_NAMES = {
    "project_list_docs",
    "project_read_doc",
    "project_grep",
    "project_outline",
    "propose_doc_edit",
    "create_suggestion",
}


@dataclass(slots=True)
class NativeSkillBlock:
    id: str
    name: str
    version: int
    source: str
    content: str
    aliases: list[str] = field(default_factory=list)
    description: str = ""
    tags: list[str] = field(default_factory=list)
    content_hash: str = ""
    cache_version: int = 0
    folder_path: str = ""

    def summary_payload(self) -> dict[str, Any]:
        payload = {
            "skill_id": self.id,
            "skill_name": self.name,
            "skill_version": self.version,
            "skill_source": self.source,
            "skill_cache_version": self.cache_version,
            "description": self.description,
            "tags": list(self.tags or []),
            "content_hash": self.content_hash or _content_hash(self.content),
        }
        aliases = _unique_non_empty(self.aliases)
        if aliases:
            payload["skill_aliases"] = aliases
        return payload

    def activation_payload(self, *, reason: str = "") -> dict[str, Any]:
        return {**self.summary_payload(), "reason": reason.strip()}


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
    # Project scope for the project_* tools. Both must be set for those tools
    # to be usable; handlers re-check ownership so an Agent cannot reach docs
    # outside this (project, user) tuple.
    project_id: str = ""
    user_id: str = ""
    temperature: float = 0.2
    max_tokens: int = 4000
    # Deprecated compatibility field. Native Agents now continue tool use until
    # the model stops calling tools or the user/client aborts the stream.
    max_tool_rounds: int = 0
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
    prior_messages: list[dict[str, Any]] = field(default_factory=list)
    allow_project_context: bool = False


@dataclass(slots=True)
class _ToolExecutionResult:
    content: str
    failed: bool = False
    failed_function_name: str = ""
    tool_kind: str = "workspace"
    trace_payload: dict[str, Any] | None = None
    # Set when the tool wants the runner to surface a side-channel event
    # (e.g. propose_doc_edit emits an edit proposal card to the chat UI).
    side_event: dict[str, Any] | None = None


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
        in_workflow_chat = bool(payload.prior_messages)
        allow_project_context = _payload_allows_project_context(payload)
        session_id = None if in_workflow_chat else (payload.conversation_id or None)

        yield {
            "event": "native.agent.step",
            "data": {
                "agent_id": self.config.agent_id,
                "agent_name": self.config.agent_name,
                "model": self.config.model,
                "skill_count": len(self.config.skills),
                "available_skills": [skill.summary_payload() for skill in self.config.skills],
            },
        }

        if self.config.workspace_root and (not in_workflow_chat or allow_project_context or self.config.skills):
            async for evt in self._stream_with_workspace_tools(
                client,
                system_prompt,
                user_prompt,
                session_id,
                payload,
                project_context_only=in_workflow_chat and allow_project_context,
                skill_only=in_workflow_chat and not allow_project_context,
            ):
                yield evt
            return

        async for evt in client.run_streaming(
            model=self.config.model,
            messages=[
                {"role": "system", "content": system_prompt},
                *payload.prior_messages,
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

    def prompt_audit_payload(self, payload: NativeRunPayload) -> dict[str, Any]:
        prior_messages = list(payload.prior_messages or [])
        return {
            "system_prompt": self._system_prompt(payload),
            "user_prompt": self._user_prompt(payload),
            "prior_messages": prior_messages,
            "message_count": len(prior_messages) + 2,
        }

    async def execute_browser_nanobot_tool(
        self,
        call: dict[str, Any],
        payload: NativeRunPayload,
    ) -> _ToolExecutionResult:
        """Execute the small SuperLeaf tool subset exposed to browser Nanobot.

        Browser-side Nanobot runs are transported by the frontend, but the
        backend remains the authorization boundary for project reads and edit
        proposals. Keep this surface intentionally narrower than native Agents:
        no workspace file reads, no project file creation, no MCP calls.
        """
        return await self.execute_browser_superleaf_tool(
            call,
            payload,
            tool_kind="browser_nanobot",
            surface_name="browser Nanobot",
        )

    async def execute_browser_superleaf_tool(
        self,
        call: dict[str, Any],
        payload: NativeRunPayload,
        *,
        tool_kind: str = "browser_local_agent",
        surface_name: str = "browser local Agent",
    ) -> _ToolExecutionResult:
        """Execute the small SuperLeaf tool subset exposed to browser transports."""
        name = _tool_call_name(call)
        if name not in _BROWSER_NANOBOT_TOOL_NAMES:
            return _ToolExecutionResult(
                f"ERROR: tool {name or '(missing)'} is not available for {surface_name} runs",
                failed=True,
                failed_function_name=name,
                tool_kind=tool_kind,
            )
        return await self._execute_tool(call, {}, payload)

    def _system_prompt(self, payload: NativeRunPayload | None = None) -> str:
        inputs = (payload.inputs if payload else {}) or {}
        write_mode = str(inputs.get("write_mode") or "").strip()
        legacy_output_mode = str(inputs.get("automation_output_mode") or "").strip()
        is_write_mode = bool(write_mode) or legacy_output_mode == "write"
        in_workflow_chat = bool(payload and payload.prior_messages)
        allow_project_context = _payload_allows_project_context(payload)

        parts = [
            "You are a native SuperLeaf Agent.",
        ]
        if in_workflow_chat:
            parts.extend(
                [
                    "This call is one node in a workflow group chat.",
                    "Use only the provided prior messages and current node context.",
                    (
                        "The original user task inside prior messages has highest "
                        "priority; Agent or node instructions may shape role or "
                        "format only when they do not conflict with that task."
                    ),
                    (
                        "Speaker labels such as [node round N] in prior messages are "
                        "metadata. Do not copy, continue, or invent bracketed speaker "
                        "labels in your own output unless the user explicitly asks for them."
                    ),
                ]
            )
            if allow_project_context:
                parts.extend(
                    [
                        (
                            "Read-only project document tools are available because this "
                            "node explicitly asks for project context."
                        ),
                        (
                            "Prefer the visible prior messages. Use project tools only when "
                            "the current node instructions require reading, searching, or "
                            "checking project documents."
                        ),
                        (
                            "Do not use project documents to replace or ignore the visible "
                            "group-chat history."
                        ),
                    ]
                )
            else:
                parts.extend(
                    [
                        (
                            "Do not read project documents, active editor content, "
                            "workspace files, or external sources."
                        ),
                        (
                            "If required information is not in the visible messages, "
                            "say so briefly instead of inventing it."
                        ),
                    ]
                )
        else:
            parts.extend(
                [
                    "You must only use the user message and your assigned Agent workspace.",
                    "Your only readable workspace is `.agents/` for this Agent.",
                    "Use list_agent_files and read_agent_file when you need Skill files.",
                    "Never claim to read files outside `.agents/`.",
                    (
                        "Project context tools: "
                        "use project_list_docs to discover documents in the current project, "
                        "project_outline(doc_id) for a quick heading map, "
                        "project_read_doc(doc_id, range_start?, range_end?) to read content, "
                        "and project_grep(pattern, format?) to search across the project. "
                        "Use project_write_text_file(path, content, format?) only when the user "
                        "explicitly asks you to create a new project file. It creates the text "
                        "document in the current project and writes the complete content in the "
                        "same database operation. It refuses to overwrite existing files."
                    ),
                    (
                        "Project file creation rule: if the user asks you to create, write, add, "
                        "or generate a new project file, you must call project_write_text_file "
                        "with the complete file content in this turn. Do not merely say you will "
                        "create the file. Read only the minimum context needed, and then create "
                        "a useful draft with clear assumptions if full context is not available."
                    ),
                    (
                        "Document edit tool: when the user asks you to change the text of the "
                        "current document, call propose_doc_edit(range_start, range_end, new_text, reason?). "
                        "To specify the edit range, also pass the exact text you want to replace as "
                        "original_text — the system will locate it automatically and character offsets "
                        "become only a disambiguation hint. Always read the surrounding context first "
                        "(project_read_doc) to get the exact text. "
                        "This proposes the change as a card in the chat — the user must click accept "
                        "to actually apply it. Do NOT paste the replacement text directly into your "
                        "markdown reply; use the tool."
                    ),
                    (
                        "Annotation tool: when the user EXPLICITLY asks to create an annotation, "
                        "suggestion card, or persistent note, call create_suggestion(original_text, content). "
                        "This creates a durable annotation in the annotation panel (saved to database). "
                        "Do NOT use create_suggestion for normal editing requests — use propose_doc_edit. "
                        "Only use create_suggestion when the user says things like "
                        "'create an annotation', 'add a suggestion card', '留下批注' etc."
                    ),
                    (
                        "If MCP tools are available, call them only when the user explicitly asks "
                        "for external retrieval, academic search, paper lookup, citation lookup, "
                        "or source-backed evidence."
                    ),
                    (
                        "Do not use MCP tools for ordinary editing, rewriting, style review, "
                        "or summarization unless the user asks to search or verify external sources."
                    ),
                    (
                        "If an MCP tool result reports `status: failed`, "
                        "continue with the best available answer."
                    ),
                    "Explicitly tell the user the external MCP retrieval failed, include the failure reason,",
                    (
                        "ask the user to check MCP configuration/API key/quota, "
                        "and avoid presenting failed tool results as facts."
                    ),
                ]
            )
        if not is_write_mode:
            parts.append(
                "Do not mutate existing documents. Creating a new project file is allowed only "
                "when the user explicitly asks for a new file or reference file; that creation "
                "must include the file content."
            )
        if self.config.instructions.strip():
            parts.extend(["", "Agent instructions:", self.config.instructions.strip()])
        if self.config.skills:
            parts.append("")
            parts.append("Available Skills:")
            for skill in self.config.skills:
                parts.append(
                    (
                        f"- {skill.id}: {skill.name} v{skill.version} "
                        f"({skill.source})"
                    ).strip()
                )
                aliases = _unique_non_empty(skill.aliases)
                if aliases:
                    parts.append(f"  Aliases: {', '.join(aliases)}")
                if skill.description.strip():
                    parts.append(f"  Description: {skill.description.strip()}")
                if skill.tags:
                    parts.append(f"  Tags: {', '.join(str(tag) for tag in skill.tags if str(tag).strip())}")
            parts.extend(
                [
                    (
                        "If a Skill is relevant, call use_skill(skill_id, reason) "
                        "before relying on its instructions."
                    ),
                    "Do not assume full Skill instructions unless use_skill returned them.",
                ]
            )
        if is_write_mode:
            doc_format = str(inputs.get("doc_format") or "").strip().lower()
            fence_lang = "latex" if doc_format == "tex" else ("markdown" if doc_format == "md" else "text")
            parts.extend(
                [
                    "",
                    (
                        "Output mode: WRITE. The user has requested direct text output "
                        "that will be written into the document."
                    ),
                    f"Wrap the full target text in a fenced code block: ```{fence_lang} ... ```",
                    (
                        "Do NOT output JSON, do NOT output annotation cards, "
                        "do NOT add explanation outside the fence."
                    ),
                    (
                        "If the user message contains [PRE-EXISTING TEXT], preserve its "
                        "preamble, style, and indentation; modify only what the user "
                        "instruction asks."
                    ),
                ]
            )
            if doc_format == "tex":
                parts.extend(
                    [
                        "",
                        "TARGET FORMAT: LaTeX (.tex).",
                        (
                            "- Use LaTeX commands: \\section{...}, \\subsection{...}, "
                            "\\textbf{...}, \\emph{...}, \\cite{key}, \\ref{label}, "
                            "inline math $...$, display math \\[...\\] or equation "
                            "environment, lists via itemize/enumerate."
                        ),
                        (
                            "- DO NOT use Markdown syntax: no `# heading`, no `**bold**`, "
                            "no `*italic*`, no `- bullet` outside itemize, no `[text](url)`, "
                            "no inner triple-backtick code fences (the only fence is the "
                            "outermost output fence)."
                        ),
                        (
                            "- Preserve every existing \\command{...} and citation key "
                            "verbatim. Do not rewrite \\cite{X} as [X]."
                        ),
                        (
                            "- Escape LaTeX special characters correctly when they appear "
                            "as text: % & _ # $ { }."
                        ),
                    ]
                )
            elif doc_format == "md":
                parts.extend(
                    [
                        "",
                        "TARGET FORMAT: Markdown (.md).",
                        (
                            "- Use Markdown syntax: `# heading`, `**bold**`, `*italic*`, "
                            "`-` / `1.` lists, `[text](url)`, inline code with backticks."
                        ),
                        (
                            "- DO NOT use LaTeX commands such as \\section, \\textbf, "
                            "\\cite, \\ref. If the source has math, keep it as `$...$` "
                            "or `$$...$$`."
                        ),
                        (
                            "- If you need a nested code block inside the output, use `~~~` "
                            "or more backticks to avoid colliding with the outer ``` fence."
                        ),
                    ]
                )
            else:
                parts.extend(
                    [
                        "",
                        "TARGET FORMAT: Plain text (.txt).",
                        (
                            "- Output plain prose only — no LaTeX commands, no Markdown "
                            "syntax. Use blank lines between paragraphs."
                        ),
                    ]
                )
        else:
            parts.extend(
                [
                    "",
                    "Return a direct Markdown response that can be rendered as-is in SuperLeaf.",
                    (
                        "Do NOT output JSON or split the answer into annotations, "
                        "suggestions, or risks unless the user or workflow explicitly asks "
                        "for that structured schema."
                    ),
                    (
                        "If you include replaceable text, put that snippet in one fenced "
                        "code block and keep its source format from the user's selected text."
                    ),
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
        in_workflow_chat = bool(payload.prior_messages)
        allow_project_context = _payload_allows_project_context(payload)
        attached_files = inputs.get("attached_files")
        if not isinstance(attached_files, list):
            attached_files = payload.context_files

        parts: list[str] = []
        if not in_workflow_chat:
            parts.extend(
                [
                    f"Document id: {payload.document_id}",
                    f"Selected range: {payload.range_start}-{payload.range_end}",
                ]
            )
        elif allow_project_context:
            parts.extend(
                [
                    "Project context access: enabled for this node.",
                    f"Active document id: {payload.document_id}",
                    f"Selected range: {payload.range_start}-{payload.range_end}",
                    "Use these only if the current node instruction requires project context.",
                ]
            )
        if section_title:
            parts.append(f"Section: {section_title}")
        if instruction:
            if in_workflow_chat:
                parts.extend(["", instruction])
            else:
                parts.extend(["", "User instruction:", instruction])
        if selection_text and not in_workflow_chat:
            parts.extend(["", "Selected text:", selection_text])
        if (before or after) and not in_workflow_chat:
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
        payload: NativeRunPayload,
        *,
        project_context_only: bool = False,
        skill_only: bool = False,
    ) -> AsyncIterator[dict[str, Any]]:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            *payload.prior_messages,
            {"role": "user", "content": user_prompt},
        ]
        mcp_refs = [] if project_context_only or skill_only else await discover_mcp_tools(self.config.runtime_config)
        mcp_tool_map = {ref.function_name: ref for ref in mcp_refs}
        if skill_only:
            base_tools = _skill_tools()
        elif project_context_only:
            base_tools = _project_context_tools() + _skill_tools()
        else:
            base_tools = _workspace_tools()
            base_tools = base_tools + _skill_tools()
        tools = base_tools + [ref.definition for ref in mcp_refs]

        while True:
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
            created_files: list[dict[str, str]] = []
            for call in tool_calls:
                result = await self._execute_tool(call, mcp_tool_map, payload)
                yield {
                    "event": "native.agent.tool",
                    "data": {
                        "name": call.get("function", {}).get("name", ""),
                        "result_preview": result.content[:500],
                        "failed": result.failed,
                        "tool_kind": result.tool_kind,
                    },
                }
                if result.trace_payload and result.tool_kind == "skill" and not result.failed:
                    yield {
                        "event": "native.agent.skill.activated",
                        "data": result.trace_payload,
                    }
                if result.side_event:
                    yield result.side_event
                if result.tool_kind == "project_write" and not result.failed:
                    created = _project_write_summary(result.content)
                    if created is not None:
                        created_files.append(created)
                if result.tool_kind == "project_write" and result.failed:
                    yield {
                        "event": "native.agent.output.delta",
                        "data": {
                            "delta": (
                                "\n\n[诊断] project_write_text_file 已被调用，"
                                f"但工具执行失败：{result.content}"
                            )
                        },
                    }
                    return
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id") or "tool-call",
                        "content": result.content,
                    }
                )
            if created_files:
                delta = _format_created_files_delta(created_files)
                yield {"event": "native.agent.output.delta", "data": {"delta": delta}}
                return

    async def _execute_tool(
        self,
        call: dict[str, Any],
        mcp_tool_map: dict[str, McpToolRef],
        payload: NativeRunPayload | None = None,
    ) -> _ToolExecutionResult:
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
                return _ToolExecutionResult(
                    json.dumps(
                        [{"path": file.path, "type": file.type, "size": file.size} for file in files],
                        ensure_ascii=False,
                    )
                )
            if name == "read_agent_file":
                path = str(args.get("path") or "")
                content = read_agent_workspace_file(root, path)
                return _ToolExecutionResult(content)
            if name == "use_skill":
                return self._tool_use_skill(args)
            if name == "project_list_docs":
                return self._tool_project_list_docs(args)
            if name == "project_read_doc":
                return self._tool_project_read_doc(args)
            if name == "project_grep":
                return self._tool_project_grep(args)
            if name == "project_outline":
                return self._tool_project_outline(args)
            if name in {"project_write_text_file", "project_create_text_file"}:
                result = self._tool_project_write_text_file(args)
                result.tool_kind = "project_write"
                return result
            if name == "propose_doc_edit":
                return self._tool_propose_doc_edit(args, payload)
            if name == "create_suggestion":
                return self._tool_create_suggestion(args, payload)
            if name in mcp_tool_map:
                ref = mcp_tool_map[name]
                try:
                    result = await call_mcp_tool(ref, args)
                except Exception as exc:  # noqa: BLE001
                    return _mcp_failure_result(
                        ref,
                        error_type=_mcp_error_type(f"{type(exc).__name__}: {exc}"),
                        detail=f"{type(exc).__name__}: {exc}",
                    )
                if _mcp_result_is_error(result):
                    detail = _mcp_error_detail(result)
                    return _mcp_failure_result(
                        ref,
                        error_type=_mcp_error_type(detail),
                        detail=detail,
                        raw_result=result,
                    )
                return _ToolExecutionResult(result, tool_kind="mcp")
        except AgentWorkspaceError as exc:
            return _ToolExecutionResult(f"ERROR: {exc}")
        except Exception as exc:  # noqa: BLE001
            return _ToolExecutionResult(f"ERROR: {type(exc).__name__}: {exc}")
        return _ToolExecutionResult(f"ERROR: unknown tool {name}")

    def _tool_use_skill(self, args: dict[str, Any]) -> _ToolExecutionResult:
        skill_id = str(args.get("skill_id") or "").strip()
        reason = str(args.get("reason") or "").strip()
        if not skill_id:
            return _ToolExecutionResult("ERROR: skill_id is required", failed=True, tool_kind="skill")
        skill = self._skill_by_ref(skill_id)
        if skill is None:
            available = ", ".join(s.name for s in self.config.skills)
            return _ToolExecutionResult(
                f"ERROR: skill not found. Available: {available}",
                failed=True,
                tool_kind="skill",
            )
        # Resolve the skill folder on disk
        root = Path(self.config.workspace_root)
        skill_path = root / ".agents" / skill.folder_path
        # If pointing to a .skillref.json, resolve the target_path
        if skill_path.is_file() and skill_path.suffix == ".json":
            try:
                ref = json.loads(skill_path.read_text(encoding="utf-8"))
                target = ref.get("target_path", "")
                folder = Path(target) if target else skill_path.parent
            except (OSError, json.JSONDecodeError):
                return _ToolExecutionResult("ERROR: cannot resolve skill reference", failed=True, tool_kind="skill")
        else:
            folder = skill_path
        # Read only SKILL.md
        skill_md = folder / "SKILL.md"
        if not skill_md.is_file():
            return _ToolExecutionResult("ERROR: SKILL.md not found", failed=True, tool_kind="skill")
        try:
            content = skill_md.read_text(encoding="utf-8", errors="replace").strip()
        except OSError as exc:
            return _ToolExecutionResult(f"ERROR: {exc}", failed=True, tool_kind="skill")
        if not content:
            return _ToolExecutionResult("ERROR: SKILL.md is empty", failed=True, tool_kind="skill")
        # Build file tree listing
        tree = _skill_file_tree(folder)
        payload = skill.activation_payload(reason=reason)
        return _ToolExecutionResult(
            content + "\n\n---\n\nFiles in this Skill:\n" + tree,
            tool_kind="skill",
            trace_payload=payload,
        )

    def _skill_by_ref(self, skill_id: str) -> NativeSkillBlock | None:
        needle = _normalize_skill_ref(skill_id)
        for skill in self.config.skills:
            refs = [skill.id, skill.name, *skill.aliases]
            if any(_normalize_skill_ref(ref) == needle for ref in refs):
                return skill
        return None

    # ------------------------------------------------------------------
    # project_* tools. Every handler opens a short-lived session and filters
    # by project_id/user_id from runtime config; Agent inputs never reach the
    # project scope clause.
    # ------------------------------------------------------------------

    def _project_scope_ok(self) -> bool:
        return bool(self.config.project_id and self.config.user_id)

    def _tool_project_list_docs(self, args: dict[str, Any]) -> _ToolExecutionResult:
        if not self._project_scope_ok():
            return _ToolExecutionResult("ERROR: project scope not available", failed=True)
        with SessionLocal() as db:
            rows = (
                db.query(Doc.id, Doc.name, Doc.format, Doc.folder_id, Doc.updated_at)
                .filter(
                    Doc.project_id == self.config.project_id,
                )
                .order_by(Doc.name.asc())
                .limit(_PROJECT_LIST_LIMIT)
                .all()
            )
        out = [
            {
                "id": r.id,
                "name": r.name,
                "format": r.format,
                "folder_id": r.folder_id or "",
                "updated_at": r.updated_at.isoformat() if r.updated_at else "",
            }
            for r in rows
        ]
        return _ToolExecutionResult(json.dumps(out, ensure_ascii=False))

    def _tool_project_read_doc(self, args: dict[str, Any]) -> _ToolExecutionResult:
        if not self._project_scope_ok():
            return _ToolExecutionResult("ERROR: project scope not available", failed=True)
        doc_id = str(args.get("doc_id") or "").strip()
        if not doc_id:
            return _ToolExecutionResult("ERROR: doc_id is required", failed=True)
        try:
            range_start = int(args.get("range_start") or 0)
            range_end_raw = args.get("range_end")
            range_end = int(range_end_raw) if range_end_raw is not None else None
        except (TypeError, ValueError):
            return _ToolExecutionResult("ERROR: range_start/range_end must be integers", failed=True)
        with SessionLocal() as db:
            doc = db.get(Doc, doc_id)
            if doc is None or doc.project_id != self.config.project_id:
                return _ToolExecutionResult("ERROR: doc not found in this project", failed=True)
            content = doc.content or ""
            name = doc.name
            fmt = doc.format
        total = len(content)
        start = max(0, min(range_start, total))
        end = total if range_end is None else max(start, min(range_end, total))
        if end - start > _PROJECT_READ_LIMIT:
            end = start + _PROJECT_READ_LIMIT
        slice_text = content[start:end]
        out = {
            "doc_id": doc_id,
            "name": name,
            "format": fmt,
            "total_length": total,
            "range_start": start,
            "range_end": end,
            "content": slice_text,
            "truncated": end < total or start > 0,
        }
        return _ToolExecutionResult(json.dumps(out, ensure_ascii=False))

    def _tool_project_grep(self, args: dict[str, Any]) -> _ToolExecutionResult:
        if not self._project_scope_ok():
            return _ToolExecutionResult("ERROR: project scope not available", failed=True)
        pattern = str(args.get("pattern") or "").strip()
        if not pattern:
            return _ToolExecutionResult("ERROR: pattern is required", failed=True)
        format_filter = str(args.get("format") or "").strip().lower()
        try:
            max_results = int(args.get("max_results") or _PROJECT_GREP_DEFAULT_LIMIT)
        except (TypeError, ValueError):
            max_results = _PROJECT_GREP_DEFAULT_LIMIT
        max_results = max(1, min(max_results, _PROJECT_GREP_HARD_LIMIT))
        try:
            regex = re.compile(pattern, re.MULTILINE)
        except re.error as exc:
            return _ToolExecutionResult(f"ERROR: invalid regex: {exc}", failed=True)
        with SessionLocal() as db:
            q = db.query(Doc.id, Doc.name, Doc.format, Doc.content).filter(
                Doc.project_id == self.config.project_id,
            )
            if format_filter:
                q = q.filter(Doc.format == format_filter)
            rows = q.all()
        hits: list[dict[str, Any]] = []
        for row in rows:
            content = row.content or ""
            for m in regex.finditer(content):
                line_start = content.rfind("\n", 0, m.start()) + 1
                line_end = content.find("\n", m.end())
                line_end = len(content) if line_end == -1 else line_end
                line_no = content.count("\n", 0, m.start()) + 1
                preview = content[line_start:line_end]
                if len(preview) > _PROJECT_GREP_PREVIEW_CHARS:
                    cut_at = max(0, m.start() - line_start - 60)
                    preview = preview[cut_at : cut_at + _PROJECT_GREP_PREVIEW_CHARS]
                hits.append(
                    {
                        "doc_id": row.id,
                        "doc_name": row.name,
                        "format": row.format,
                        "offset": m.start(),
                        "line": line_no,
                        "preview": preview,
                    }
                )
                if len(hits) >= max_results:
                    break
            if len(hits) >= max_results:
                break
        return _ToolExecutionResult(
            json.dumps(
                {"hits": hits, "truncated": len(hits) >= max_results},
                ensure_ascii=False,
            )
        )

    def _tool_project_outline(self, args: dict[str, Any]) -> _ToolExecutionResult:
        if not self._project_scope_ok():
            return _ToolExecutionResult("ERROR: project scope not available", failed=True)
        doc_id = str(args.get("doc_id") or "").strip()
        if not doc_id:
            return _ToolExecutionResult("ERROR: doc_id is required", failed=True)
        with SessionLocal() as db:
            doc = db.get(Doc, doc_id)
            if doc is None or doc.project_id != self.config.project_id:
                return _ToolExecutionResult("ERROR: doc not found in this project", failed=True)
            content = doc.content or ""
            fmt = (doc.format or "").lower()
            name = doc.name
        sections = _extract_outline(content, fmt)
        return _ToolExecutionResult(
            json.dumps(
                {"doc_id": doc_id, "name": name, "format": fmt, "sections": sections},
                ensure_ascii=False,
            )
        )

    def _tool_project_write_text_file(self, args: dict[str, Any]) -> _ToolExecutionResult:
        if not self._project_scope_ok():
            return _ToolExecutionResult("ERROR: project scope not available", failed=True)
        path_raw = str(args.get("path") or "")
        try:
            path_parts = _normalize_project_create_path(path_raw)
        except ValueError as exc:
            return _ToolExecutionResult(f"ERROR: {exc}", failed=True)

        content = args.get("content")
        if not isinstance(content, str):
            return _ToolExecutionResult("ERROR: content must be a string", failed=True)
        content_bytes = len(content.encode("utf-8"))
        if content_bytes > _PROJECT_CREATE_CONTENT_LIMIT:
            return _ToolExecutionResult(
                f"ERROR: content exceeds {_PROJECT_CREATE_CONTENT_LIMIT} bytes",
                failed=True,
            )

        name = path_parts[-1]
        try:
            doc_format = _project_doc_format_for_name(name, args.get("format"))
        except ValueError as exc:
            return _ToolExecutionResult(f"ERROR: {exc}", failed=True)

        with SessionLocal() as db:
            project = db.get(Project, self.config.project_id)
            if project is None:
                return _ToolExecutionResult("ERROR: project not found", failed=True)
            if not ProjectMemberService(db).can_write(project.id, self.config.user_id):
                return _ToolExecutionResult("ERROR: project write access required", failed=True)

            svc = ProjectFsService(db, project)
            parent_folder_id: str | None = None
            for folder_name in path_parts[:-1]:
                conflict = _project_sibling_kind(db, project.id, parent_folder_id, folder_name)
                if conflict in {"doc", "file"}:
                    return _ToolExecutionResult(
                        f"ERROR: cannot create folder '{folder_name}' because a {conflict} "
                        "with that name already exists",
                        failed=True,
                    )
                folder = _project_find_folder(db, project.id, parent_folder_id, folder_name)
                if folder is None:
                    try:
                        folder = svc.create_folder(
                            parent_folder_id=parent_folder_id,
                            name=folder_name,
                        )
                    except ValueError as exc:
                        return _ToolExecutionResult(f"ERROR: {exc}", failed=True)
                parent_folder_id = folder.id

            existing = _project_sibling_kind(db, project.id, parent_folder_id, name)
            if existing is not None:
                return _ToolExecutionResult(
                    f"ERROR: cannot create '{name}' because a {existing} with that name already exists",
                    failed=True,
                )
            try:
                doc = svc.create_doc(
                    folder_id=parent_folder_id,
                    name=name,
                    format=doc_format,
                    content=content,
                )
            except ValueError as exc:
                return _ToolExecutionResult(f"ERROR: {exc}", failed=True)

            payload = {
                "action": "doc.created",
                "doc_id": doc.id,
                "folder_id": doc.folder_id,
                "name": doc.name,
                "format": doc.format,
                "path": "/".join(path_parts),
                "doc": _tree_doc_payload(doc),
            }
            bus.publish(project.id, "project.tree.changed", payload, origin_client_id="")

        return _ToolExecutionResult(
            json.dumps(
                {
                    "status": "created",
                    "doc_id": payload["doc_id"],
                    "path": payload["path"],
                    "name": payload["name"],
                    "format": payload["format"],
                    "size_bytes": payload["doc"]["size_bytes"],
                },
                ensure_ascii=False,
            ),
            tool_kind="project_write",
            side_event={"event": "native.agent.project_file_created", "data": payload},
        )

    def _tool_propose_doc_edit(
        self,
        args: dict[str, Any],
        payload: NativeRunPayload,
    ) -> _ToolExecutionResult:
        """Surface an edit proposal to the chat UI; never writes the doc.

        Scope is locked to payload.document_id — the agent cannot target other
        docs. Supports two positioning modes:
        - Text anchor (preferred): Agent passes ``original_text`` and the
          handler locates it in the live document via ``str.find()``.
        - Numeric offset (legacy/fallback): Agent passes ``range_start`` /
          ``range_end`` directly.
        When both are provided, ``original_text`` takes priority and offsets
        are used only as a disambiguation hint for duplicate matches.
        """
        if not self._project_scope_ok():
            return _ToolExecutionResult("ERROR: project scope not available", failed=True)
        document_id = (payload.document_id or "").strip()
        if not document_id:
            return _ToolExecutionResult(
                "ERROR: propose_doc_edit requires an active document; none is bound to this conversation",
                failed=True,
            )
        try:
            range_start = int(args.get("range_start"))
            range_end = int(args.get("range_end"))
        except (TypeError, ValueError):
            return _ToolExecutionResult(
                "ERROR: range_start and range_end must be integers", failed=True
            )
        new_text = args.get("new_text")
        if not isinstance(new_text, str):
            return _ToolExecutionResult("ERROR: new_text must be a string", failed=True)
        reason = str(args.get("reason") or "").strip()
        original_text_arg = args.get("original_text")

        with SessionLocal() as db:
            doc = db.get(Doc, document_id)
            if doc is None or doc.project_id != self.config.project_id:
                return _ToolExecutionResult(
                    "ERROR: active document not found in this project", failed=True
                )
            content = doc.content or ""
        total = len(content)

        # --- Resolve range ---
        anchor_text: str | None = None
        if isinstance(original_text_arg, str) and original_text_arg.strip():
            # Text anchor positioning (preferred)
            # For propose_doc_edit, also consider payload.range_start as disambiguation hint
            start, end, anchor_text, err = _resolve_text_range(
                content, original_text_arg,
                range_start if range_start > 0 else (payload.range_start or 0),
                range_end,
            )
            if err:
                return _ToolExecutionResult(err, failed=True)
        else:
            # Legacy numeric offset
            start = max(0, min(range_start, total))
            end = max(start, min(range_end, total))

        original_text = content[start:end]

        proposal_id = uuid.uuid4().hex
        proposal = {
            "proposal_id": proposal_id,
            "document_id": document_id,
            "range_start": start,
            "range_end": end,
            "original_text": original_text,
            "new_text": new_text,
            "reason": reason,
            "anchor_text": anchor_text,
        }

        tool_reply = {
            "status": "proposed",
            "proposal_id": proposal_id,
            "document_id": document_id,
            "range_start": start,
            "range_end": end,
            "note": (
                "Proposal queued; awaiting user approval in chat. "
                "Do not propose the same edit again — briefly explain the intent in plain text."
            ),
        }
        return _ToolExecutionResult(
            json.dumps(tool_reply, ensure_ascii=False),
            tool_kind="edit_proposal",
            side_event={"event": "native.agent.edit_proposal", "data": proposal},
        )

    def _tool_create_suggestion(
        self,
        args: dict[str, Any],
        payload: NativeRunPayload,
    ) -> _ToolExecutionResult:
        """Create a persistent suggestion annotation card.

        Anchors to the document using the same text-anchor logic as
        ``propose_doc_edit`` but emits a ``suggestion_created`` side event
        instead of an ``edit_proposal``.
        """
        if not self._project_scope_ok():
            return _ToolExecutionResult("ERROR: project scope not available", failed=True)
        document_id = (payload.document_id or "").strip()
        if not document_id:
            return _ToolExecutionResult(
                "ERROR: create_suggestion requires an active document", failed=True
            )
        original_text_arg = args.get("original_text")
        if not isinstance(original_text_arg, str) or not original_text_arg.strip():
            return _ToolExecutionResult("ERROR: original_text is required", failed=True)
        content_arg = args.get("content")
        if not isinstance(content_arg, str) or not content_arg.strip():
            return _ToolExecutionResult("ERROR: content is required", failed=True)
        proposed_text = str(args.get("proposed_text") or "")
        reason = str(args.get("reason") or "").strip()

        try:
            range_start = int(args.get("range_start") or 0)
            range_end = int(args.get("range_end") or 0)
        except (TypeError, ValueError):
            range_start, range_end = 0, 0

        with SessionLocal() as db:
            doc = db.get(Doc, document_id)
            if doc is None or doc.project_id != self.config.project_id:
                return _ToolExecutionResult(
                    "ERROR: active document not found in this project", failed=True
                )
            doc_content = doc.content or ""

        # Resolve text range (same logic as propose_doc_edit)
        start, end, anchor_text, err = _resolve_text_range(
            doc_content, original_text_arg, range_start, range_end,
        )
        if err:
            return _ToolExecutionResult(err, failed=True)

        original_text = doc_content[start:end]

        suggestion_id = uuid.uuid4().hex
        suggestion = {
            "suggestion_id": suggestion_id,
            "document_id": document_id,
            "range_start": start,
            "range_end": end,
            "original_text": original_text,
            "proposed_text": proposed_text,
            "content": content_arg,
            "reason": reason,
            "anchor_text": anchor_text,
        }

        return _ToolExecutionResult(
            json.dumps(
                {"status": "created", "suggestion_id": suggestion_id},
                ensure_ascii=False,
            ),
            tool_kind="create_suggestion",
            side_event={"event": "native.agent.suggestion_created", "data": suggestion},
        )


def _resolve_text_range(
    content: str,
    original_text: str,
    range_start: int,
    range_end: int,
) -> tuple[int, int, str | None, str | None]:
    """Resolve the text range for an edit or suggestion.

    Returns ``(start, end, anchor_text, error)``.  On success ``error`` is
    ``None``; on failure ``start/end`` are 0 and ``error`` contains the
    error message.
    """
    anchor = original_text
    anchor_text: str | None = anchor

    # Find all occurrences
    occurrences: list[int] = []
    pos = 0
    while True:
        idx = content.find(anchor, pos)
        if idx == -1:
            break
        occurrences.append(idx)
        pos = idx + 1

    if len(occurrences) == 1:
        return occurrences[0], occurrences[0] + len(anchor), anchor_text, None
    elif len(occurrences) > 1:
        hint = range_start if range_start > 0 else 0
        if hint > 0:
            closest = min(occurrences, key=lambda x: abs(x - hint))
            return closest, closest + len(anchor), anchor_text, None
        return 0, 0, None, (
            f"ERROR: original_text appears {len(occurrences)} times "
            f"in the document. Select the target text in the editor "
            f"so the system can disambiguate."
        )
    else:
        # Exact match failed — try fuzzy
        fuzzy_pos = _fuzzy_find(content, anchor, threshold=0.85)
        if fuzzy_pos is not None:
            return fuzzy_pos, fuzzy_pos + len(anchor), anchor_text, None
        return 0, 0, None, (
            "ERROR: original_text not found in document. "
            "The document may have changed. Please call project_read_doc "
            "to re-read the current content and try again."
        )


def _fuzzy_find(content: str, anchor: str, threshold: float = 0.85) -> int | None:
    """Find the position in *content* most similar to *anchor*.

    Uses a sliding-window approach with ``difflib.SequenceMatcher``.
    Returns the start index or ``None`` if the best match is below *threshold*.
    """
    from difflib import SequenceMatcher

    anchor_len = len(anchor)
    if anchor_len == 0:
        return None
    best_ratio = 0.0
    best_pos: int | None = None
    step = max(1, anchor_len // 4)
    for i in range(0, len(content) - anchor_len + 1, step):
        window = content[i : i + anchor_len]
        ratio = SequenceMatcher(None, anchor, window).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_pos = i
            if ratio >= 0.95:
                break  # Good enough — early exit.
    if best_ratio >= threshold and best_pos is not None:
        return best_pos
    return None


def _mcp_failure_result(
    ref: McpToolRef,
    *,
    error_type: str,
    detail: str,
    raw_result: str = "",
) -> _ToolExecutionResult:
    payload: dict[str, Any] = {
        "status": "failed",
        "tool_type": "mcp",
        "error_type": error_type,
        "server": ref.server.name,
        "server_id": ref.server.id,
        "tool_name": ref.tool_name,
        "function_name": ref.function_name,
        "detail": _clip_text(detail, 4000),
        "user_action": "请检查 MCP 配置、API key、远程服务访问权限或匿名访问限额。",
        "agent_instruction": (
            "The external MCP tool failed or was rejected. Continue with the best available "
            "response, explicitly tell the user that external MCP retrieval failed, include "
            "the failure reason, ask the user to check MCP configuration/API key/quota, and "
            "do not cite this failed tool result as evidence."
        ),
    }
    if raw_result:
        payload["raw_result_preview"] = _clip_text(raw_result, 4000)
    return _ToolExecutionResult(
        json.dumps(payload, ensure_ascii=False),
        failed=True,
        failed_function_name=ref.function_name,
        tool_kind="mcp",
    )


def _mcp_result_is_error(result: str) -> bool:
    parsed = _parse_json_object(result)
    if parsed is not None:
        if parsed.get("isError") is True:
            return True
        if parsed.get("status") in {"failed", "error"}:
            return True
        if parsed.get("error"):
            return True
    lower = result.casefold()
    return lower.startswith("error") or any(
        token in lower
        for token in (
            "rate limit",
            "rate_limit",
            "rate-limit",
            "permission denied",
            "access denied",
            "forbidden",
            "unauthorized",
        )
    )


def _mcp_error_detail(result: str) -> str:
    parsed = _parse_json_object(result)
    if parsed is None:
        return _clip_text(result, 4000)

    content = parsed.get("content")
    if isinstance(content, list):
        text_parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                text_parts.append(item["text"])
        if text_parts:
            return _clip_text("\n".join(text_parts), 4000)

    for key in ("detail", "message", "error"):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            return _clip_text(value, 4000)
        if value is not None:
            return _clip_text(json.dumps(value, ensure_ascii=False), 4000)

    return _clip_text(result, 4000)


def _mcp_error_type(text: str) -> str:
    lower = text.casefold()
    if any(token in lower for token in ("rate limit", "rate_limit", "rate-limit", "429", "quota")):
        return "rate_limited"
    if any(
        token in lower
        for token in (
            "access denied",
            "permission denied",
            "forbidden",
            "unauthorized",
            "authentication",
            "api key",
            "401",
            "403",
        )
    ):
        return "access_denied"
    if any(token in lower for token in ("timeout", "timed out")):
        return "timeout"
    if any(
        token in lower
        for token in (
            "server unavailable",
            "closed stdout",
            "connection",
            "connecterror",
            "nodename",
            "servname",
        )
    ):
        return "server_unavailable"
    return "tool_error"


def _parse_json_object(text: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _clip_text(text: str, limit: int) -> str:
    clean = str(text)
    return clean if len(clean) <= limit else clean[:limit] + "\n...[truncated]"


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


def browser_nanobot_system_prompt() -> str:
    return "\n".join(
        [
            "You are a local Nanobot Agent collaborating inside SuperLeaf.",
            "The browser is your transport; SuperLeaf backend executes project tools after authorization.",
            "Use project_read_doc, project_grep, project_outline, or project_list_docs when you need SuperLeaf document context.",
            (
                "Do not use your own local filesystem or shell as a substitute for SuperLeaf project tools. "
                "SuperLeaf project context exists only through the tools listed in this prompt."
            ),
            (
                "If this API channel cannot call tools natively, request exactly one SuperLeaf tool by "
                "replying with only this marker and no Markdown: "
                '<superleaf_tool_call>{"name":"project_list_docs","arguments":{}}</superleaf_tool_call>. '
                "Replace name and arguments as needed."
            ),
            (
                "When the user asks you to change the current document, call "
                "propose_doc_edit with original_text copied from project_read_doc, "
                "range_start/range_end as hints, replacement new_text, and a short reason."
            ),
            (
                "Do not claim that an edit has been applied. propose_doc_edit only creates "
                "a proposal card; the user must accept it before the document changes."
            ),
            "Do not ask SuperLeaf to record local files read, commands run, or internal reasoning.",
            "Return concise Markdown for ordinary answers.",
        ]
    )


def browser_codex_system_prompt() -> str:
    return "\n".join(
        [
            "You are a local Codex Agent collaborating inside SuperLeaf.",
            "You may use your normal local code and repository capabilities when relevant.",
            "SuperLeaf project documents, comments, selections, and edit proposals are not your local filesystem; access them through the SuperLeaf tools listed in this prompt.",
            "Use project_read_doc, project_grep, project_outline, or project_list_docs when you need SuperLeaf document context.",
            (
                "If native MCP/function tools are available, call the SuperLeaf tool directly. "
                "Only if no direct tool channel is available, request one SuperLeaf tool by replying "
                "with exactly one marker and no prose: "
                '<superleaf_tool_call>{"name":"project_list_docs","arguments":{}}</superleaf_tool_call>. '
                "Replace name and arguments as needed."
            ),
            (
                "When the user asks you to modify a SuperLeaf document, first read the relevant text if needed, "
                "then call propose_doc_edit with original_text copied verbatim from project_read_doc, "
                "range_start/range_end as hints, replacement new_text, and a short reason."
            ),
            (
                "Do not claim that a SuperLeaf edit has been applied. propose_doc_edit only creates "
                "a proposal card; the user must accept it before the document changes."
            ),
            "Do not ask SuperLeaf to record local files read, shell commands, or internal reasoning.",
            "Return concise Markdown for ordinary answers.",
        ]
    )


def browser_nanobot_tools() -> list[dict[str, Any]]:
    return [
        tool
        for tool in _workspace_tools()
        if _tool_definition_name(tool) in _BROWSER_NANOBOT_TOOL_NAMES
    ]


def _tool_definition_name(tool: dict[str, Any]) -> str:
    fn = tool.get("function") if isinstance(tool.get("function"), dict) else {}
    return str(fn.get("name") or "")


def _tool_call_name(call: dict[str, Any]) -> str:
    fn = call.get("function") if isinstance(call.get("function"), dict) else {}
    return str(fn.get("name") or "")


def _payload_allows_project_context(payload: NativeRunPayload | None) -> bool:
    if payload is None:
        return False
    if payload.allow_project_context:
        return True
    inputs = payload.inputs or {}
    raw = inputs.get("allow_project_context") or inputs.get("allowProjectContext")
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        return raw.strip().casefold() in {"1", "true", "yes", "on"}
    return False


def _project_write_summary(content: str) -> dict[str, str] | None:
    parsed = _parse_json_object(content)
    if parsed is None or parsed.get("status") != "created":
        return None
    path = str(parsed.get("path") or parsed.get("name") or "").strip()
    doc_id = str(parsed.get("doc_id") or "").strip()
    if not path:
        return None
    return {"path": path, "doc_id": doc_id}


def _format_created_files_delta(files: list[dict[str, str]]) -> str:
    if len(files) == 1:
        path = files[0]["path"]
        return f"\n\n已创建项目文件：`{path}`。"
    paths = "\n".join(f"- `{item['path']}`" for item in files)
    return f"\n\n已创建项目文件：\n{paths}"


def _content_hash(content: str) -> str:
    return "sha256:" + sha256(content.encode("utf-8")).hexdigest()


def _unique_non_empty(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = str(value or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def _normalize_skill_ref(value: str) -> str:
    return str(value or "").strip().lower()


def _skill_file_tree(folder: Path) -> str:
    """Return a markdown-style file tree of a skill folder."""
    lines: list[str] = []
    _FORBIDDEN = {".git", "node_modules", "__pycache__", ".venv"}
    for path in sorted(folder.rglob("*")):
        if any(part in _FORBIDDEN for part in path.parts):
            continue
        rel = path.relative_to(folder).as_posix()
        if path.is_dir():
            lines.append(f"  {rel}/")
        else:
            size = path.stat().st_size
            lines.append(f"  {rel}  ({size}B)")
    return "\n".join(lines) if lines else "(empty)"


def _normalize_project_create_path(raw_path: str) -> list[str]:
    path = raw_path.strip().replace("\\", "/")
    if not path:
        raise ValueError("path is required")
    if len(path) > _PROJECT_CREATE_MAX_PATH_CHARS:
        raise ValueError(f"path exceeds {_PROJECT_CREATE_MAX_PATH_CHARS} characters")
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        raise ValueError("path must be relative to the current project")
    if path.endswith("/"):
        raise ValueError("path must include a filename")
    raw_parts = path.split("/")
    if any(part == "" for part in raw_parts):
        raise ValueError("path must not contain empty segments")
    parts: list[str] = []
    for part in raw_parts:
        clean = part.strip()
        if clean != part:
            raise ValueError("path segments must not have leading or trailing spaces")
        if clean in {".", ".."} or clean.casefold() == ".git":
            raise ValueError("path contains a forbidden segment")
        if "\x00" in clean:
            raise ValueError("path contains an invalid character")
        if len(clean) > _PROJECT_CREATE_MAX_SEGMENT_CHARS:
            raise ValueError(
                f"path segment exceeds {_PROJECT_CREATE_MAX_SEGMENT_CHARS} characters"
            )
        parts.append(clean)
    if not parts:
        raise ValueError("path must include a filename")
    return parts


def _project_doc_format_for_name(name: str, requested: Any) -> str:
    raw = str(requested or "").strip().lower()
    if raw:
        if raw not in {"tex", "md", "txt"}:
            raise ValueError("format must be one of tex, md, or txt")
        return raw
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return _PROJECT_CREATE_DOC_EXTS.get(ext, "txt")


def _project_find_folder(
    db: Any,
    project_id: str,
    parent_folder_id: str | None,
    name: str,
) -> Folder | None:
    return (
        db.query(Folder)
        .filter(
            Folder.project_id == project_id,
            Folder.parent_folder_id == parent_folder_id,
            Folder.name == name,
        )
        .first()
    )


def _project_sibling_kind(
    db: Any,
    project_id: str,
    folder_id: str | None,
    name: str,
) -> str | None:
    if _project_find_folder(db, project_id, folder_id, name) is not None:
        return "folder"
    doc = (
        db.query(Doc.id)
        .filter(Doc.project_id == project_id, Doc.folder_id == folder_id, Doc.name == name)
        .first()
    )
    if doc is not None:
        return "doc"
    file_blob = (
        db.query(FileBlob.id)
        .filter(
            FileBlob.project_id == project_id,
            FileBlob.folder_id == folder_id,
            FileBlob.name == name,
        )
        .first()
    )
    return "file" if file_blob is not None else None


def _tree_doc_payload(doc: Doc) -> dict[str, object]:
    return {
        "id": doc.id,
        "name": doc.name,
        "format": doc.format,
        "size_bytes": len((doc.content or "").encode("utf-8")),
        "updated_at": doc.updated_at.isoformat(),
    }


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
                            "description": (
                                "File path under .agents, for example "
                                ".agents/skills/name/SKILL.md."
                            ),
                        }
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "project_list_docs",
                "description": (
                    "List all documents in the current project (read-only). "
                    "Returns id, name, format, folder_id, updated_at. "
                    "Use this to discover related files before editing."
                ),
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "project_read_doc",
                "description": (
                    "Read the contents of a project document by id. "
                    "Optional range_start/range_end (character offsets) trim the slice. "
                    "Returned content is capped at 40000 characters; pass a range to read more."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "doc_id": {"type": "string"},
                        "range_start": {
                            "type": "integer",
                            "description": "Character offset to start reading at (default 0).",
                        },
                        "range_end": {
                            "type": "integer",
                            "description": "Character offset to stop at (exclusive). Omit for end-of-doc.",
                        },
                    },
                    "required": ["doc_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "project_grep",
                "description": (
                    "Search project documents with a Python regular expression. "
                    "Returns up to max_results matches with surrounding line preview. "
                    "Optionally filter by format (e.g. 'tex' or 'md')."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "Python regex (multiline)."},
                        "format": {
                            "type": "string",
                            "description": "Restrict to docs of this format, e.g. tex or md.",
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Cap on hits returned (default 30, max 100).",
                        },
                    },
                    "required": ["pattern"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "project_outline",
                "description": (
                    "Return the heading outline (sections / chapters) of one document. "
                    "Cheap way to understand a long doc before reading the body."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {"doc_id": {"type": "string"}},
                    "required": ["doc_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "project_write_text_file",
                "description": (
                    "Create a new text document in the current project by relative path and "
                    "write its full content in the same database operation. "
                    "Use only when the user explicitly asks you to create a new project file "
                    "or reference file. Intermediate folders are created automatically. "
                    "The tool refuses to overwrite existing docs, files, or folders. "
                    "Supported document formats are tex, md, and txt; format is inferred "
                    "from the filename when possible and otherwise defaults to txt."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": (
                                "Relative project path, for example "
                                "references/paper-style.md or examples/rule.txt."
                            ),
                        },
                        "content": {
                            "type": "string",
                            "description": "Full UTF-8 text content for the new file.",
                        },
                        "format": {
                            "type": "string",
                            "enum": ["tex", "md", "txt"],
                            "description": (
                                "Optional stored document format. If omitted, inferred from "
                                "the filename extension when supported, otherwise txt."
                            ),
                        },
                    },
                    "required": ["path", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "propose_doc_edit",
                "description": (
                    "Propose a text edit to the document currently open in this discussion. "
                    "PROPOSE ONLY — the edit is NOT applied until the user clicks accept "
                    "in the chat UI. Use this whenever the user asks you to change the text. "
                    "Pass original_text (verbatim from project_read_doc) for reliable "
                    "positioning; range_start/range_end are used as hints for disambiguation. "
                    "Scope is locked to the active document."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "original_text": {
                            "type": "string",
                            "description": (
                                "The exact text you want to replace. The system uses this to locate "
                                "the correct position in the document, so character offsets are only "
                                "a hint. Pass the verbatim text from project_read_doc. "
                                "This is the recommended way to specify the edit range."
                            ),
                        },
                        "range_start": {
                            "type": "integer",
                            "description": (
                                "Character offset where the replacement starts (inclusive). "
                                "Used as a disambiguation hint when original_text appears multiple times."
                            ),
                        },
                        "range_end": {
                            "type": "integer",
                            "description": (
                                "Character offset where the replacement ends (exclusive). "
                                "Equal to range_start for a pure insertion."
                            ),
                        },
                        "new_text": {
                            "type": "string",
                            "description": "The replacement text. May be empty to delete the matched text.",
                        },
                        "reason": {
                            "type": "string",
                            "description": "Short human-readable explanation of why this change is proposed.",
                        },
                    },
                    "required": ["range_start", "range_end", "new_text"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "create_suggestion",
                "description": (
                    "Create a persistent suggestion annotation card in the annotation panel. "
                    "Unlike propose_doc_edit (which is a quick inline proposal in chat), "
                    "this creates a durable annotation that is saved to the database. "
                    "Only use this when the user EXPLICITLY asks to create an annotation "
                    "or suggestion card. Do NOT use this for normal editing requests — "
                    "use propose_doc_edit instead."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "original_text": {
                            "type": "string",
                            "description": (
                                "The exact text the annotation refers to. Copy verbatim "
                                "from project_read_doc. Used to anchor the annotation."
                            ),
                        },
                        "proposed_text": {
                            "type": "string",
                            "description": "The suggested replacement text.",
                        },
                        "content": {
                            "type": "string",
                            "description": (
                                "The annotation content/explanation shown on the card. "
                                "Describe what you suggest and why."
                            ),
                        },
                        "reason": {
                            "type": "string",
                            "description": "Short reason for the suggestion.",
                        },
                        "range_start": {
                            "type": "integer",
                            "description": "Character offset hint for disambiguation.",
                        },
                        "range_end": {
                            "type": "integer",
                            "description": "Character offset hint for disambiguation.",
                        },
                    },
                    "required": ["original_text", "content"],
                },
            },
        },
    ]


def _skill_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "use_skill",
                "description": (
                    "Load the full instructions for one available Skill. "
                    "Calling this tool means the Skill is activated for this run."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "skill_id": {
                            "type": "string",
                            "description": "The id or alias from the Available Skills list.",
                        },
                        "reason": {
                            "type": "string",
                            "description": "Brief reason this Skill is needed now.",
                        },
                    },
                    "required": ["skill_id"],
                },
            },
        }
    ]


_PROJECT_CONTEXT_TOOL_NAMES = {
    "project_list_docs",
    "project_read_doc",
    "project_grep",
    "project_outline",
}


def _project_context_tools() -> list[dict[str, Any]]:
    return [
        tool
        for tool in _workspace_tools()
        if tool.get("function", {}).get("name") in _PROJECT_CONTEXT_TOOL_NAMES
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


# project_* tool budget — keeps tool returns inside the model's context.
_PROJECT_LIST_LIMIT = 200
_PROJECT_READ_LIMIT = 40_000
_PROJECT_GREP_DEFAULT_LIMIT = 30
_PROJECT_GREP_HARD_LIMIT = 100
_PROJECT_GREP_PREVIEW_CHARS = 240

_LATEX_HEAD_RE = re.compile(
    r"^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*\{([^}]*)\}",
    re.MULTILINE,
)
_MARKDOWN_HEAD_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
_LATEX_LEVEL = {
    "part": 0,
    "chapter": 1,
    "section": 2,
    "subsection": 3,
    "subsubsection": 4,
    "paragraph": 5,
    "subparagraph": 6,
}


def _extract_outline(content: str, fmt: str) -> list[dict[str, Any]]:
    if fmt == "tex":
        regex = _LATEX_HEAD_RE
        out: list[dict[str, Any]] = []
        for m in regex.finditer(content):
            kind = m.group(1)
            out.append({
                "level": _LATEX_LEVEL.get(kind, 3),
                "kind": kind,
                "title": m.group(2).strip(),
                "offset": m.start(),
            })
        return out
    if fmt == "md":
        out = []
        for m in _MARKDOWN_HEAD_RE.finditer(content):
            out.append({
                "level": len(m.group(1)),
                "kind": "h" + str(len(m.group(1))),
                "title": m.group(2).strip(),
                "offset": m.start(),
            })
        return out
    return []

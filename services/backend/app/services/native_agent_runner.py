"""Backend runner for project-scoped native Agents.

The runner intentionally receives only explicit payload data assembled by
SuperLeaf. Project tools are scoped by project_id/user_id and write through the
same SQLite-backed project tree services as the REST API; Agents never receive
raw filesystem access.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any

from .attached_files import render_attached_files_block
from .mcp_tool_service import McpToolRef, call_mcp_tool, discover_mcp_tools
from .nanobot_client import NanobotClient
from .native_agent_tool_kernel import (
    BROWSER_SUPERLEAF_TOOL_NAMES,
    NativeAgentToolContext,
    browser_superleaf_tools,
    execute_native_agent_db_tool,
    execute_native_agent_local_tool,
    native_agent_project_context_tools,
    native_agent_skill_tools,
    native_agent_workspace_tools,
)
from .native_agent_tool_kernel import (
    NativeAgentToolResult as _ToolExecutionResult,
)


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
    multimodal_attachments: list[Any] = field(default_factory=list)  # ResolvedAttachment from multimodal_attachments module


class NativeAgentRunner:
    def __init__(self, config: NativeAgentRuntimeConfig) -> None:
        self.config = config

    async def stream(self, payload: NativeRunPayload) -> AsyncIterator[dict[str, Any]]:
        # run_streaming itself uses timeout=None for the SSE channel; this value
        # only affects probe()/list_models() and any future non-streaming calls.
        # Keep it generous so a slow Local Agent Host bootstrap doesn't surface
        # as a misleading network error.
        client = NanobotClient(
            endpoint=self.config.provider_endpoint,
            api_key=self.config.api_key,
            timeout=60.0,
        )
        system_prompt = self._system_prompt(payload)
        user_message = self._build_user_message(payload)
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

        if self.config.workspace_root and (
            not in_workflow_chat or allow_project_context or self.config.skills
        ):
            async for evt in self._stream_with_workspace_tools(
                client,
                system_prompt,
                user_message,
                session_id,
                payload,
                project_context_only=in_workflow_chat and allow_project_context,
                skill_only=in_workflow_chat and not allow_project_context,
            ):
                yield evt
            return

        # Build messages list with proper content format
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            *payload.prior_messages,
        ]
        if isinstance(user_message, dict):
            messages.append(user_message)
        else:
            messages.append({"role": "user", "content": user_message})

        async for evt in client.run_streaming(
            model=self.config.model,
            messages=messages,
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
        if name not in BROWSER_SUPERLEAF_TOOL_NAMES:
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
                        "suggestion card, or persistent note, call "
                        "create_suggestion(original_text, content). "
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

    def _build_user_message(self, payload: NativeRunPayload) -> dict[str, Any] | str:
        """Build user message content for OpenAI Chat Completions.

        Returns either:
        - Plain string when no multimodal attachments
        - {"role": "user", "content": [text_part, ...image_parts]} when multimodal
        """
        from .multimodal_attachments import to_openai_chat_content_parts

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

        text_content = "\n".join(parts).strip()

        # If no multimodal attachments, return plain string (backward compat)
        if not payload.multimodal_attachments:
            return text_content

        # Build OpenAI content parts: text + multimodal
        content_parts: list[dict[str, Any]] = [{"type": "text", "text": text_content}]
        multimodal_parts = to_openai_chat_content_parts(payload.multimodal_attachments)
        content_parts.extend(multimodal_parts)

        return {"role": "user", "content": content_parts}

    def _user_prompt(self, payload: NativeRunPayload) -> str:
        """Legacy wrapper for _build_user_message when only text is needed."""
        msg = self._build_user_message(payload)
        if isinstance(msg, str):
            return msg
        # Extract text from content parts
        if isinstance(msg, dict) and isinstance(msg.get("content"), list):
            for part in msg["content"]:
                if isinstance(part, dict) and part.get("type") == "text":
                    return str(part.get("text", ""))
        return ""

    async def _stream_with_workspace_tools(
        self,
        client: NanobotClient,
        system_prompt: str,
        user_message: dict[str, Any] | str,
        session_id: str | None,
        payload: NativeRunPayload,
        *,
        project_context_only: bool = False,
        skill_only: bool = False,
    ) -> AsyncIterator[dict[str, Any]]:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            *payload.prior_messages,
        ]
        if isinstance(user_message, dict):
            messages.append(user_message)
        else:
            messages.append({"role": "user", "content": user_message})

        mcp_refs = (
            []
            if project_context_only or skill_only
            else await discover_mcp_tools(self.config.runtime_config)
        )
        mcp_tool_map = {ref.function_name: ref for ref in mcp_refs}
        if skill_only:
            base_tools = native_agent_skill_tools()
        elif project_context_only:
            base_tools = native_agent_project_context_tools() + native_agent_skill_tools()
        else:
            base_tools = native_agent_workspace_tools()
            base_tools = base_tools + native_agent_skill_tools()
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
        try:
            tool_context = self._tool_context(payload)
            local_tool_result = execute_native_agent_local_tool(name, args, tool_context)
            if local_tool_result is not None:
                return local_tool_result
            db_tool_result = execute_native_agent_db_tool(
                name,
                args,
                tool_context,
            )
            if db_tool_result is not None:
                return db_tool_result
            if name in mcp_tool_map:
                ref = mcp_tool_map[name]
                try:
                    result = await call_mcp_tool(ref, args)
                except Exception as exc:  # noqa: BLE001
                    detail = _format_tool_exception(exc)
                    return _mcp_failure_result(
                        ref,
                        error_type=_mcp_error_type(detail),
                        detail=detail,
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
        except Exception as exc:  # noqa: BLE001
            return _tool_exception_result(exc, failed_function_name=name)
        return _ToolExecutionResult(f"ERROR: unknown tool {name}")

    def _tool_context(self, payload: NativeRunPayload | None) -> NativeAgentToolContext:
        return NativeAgentToolContext(
            project_id=self.config.project_id,
            user_id=self.config.user_id,
            active_document_id=(payload.document_id if payload else ""),
            active_range_start=(payload.range_start if payload else 0),
            active_range_end=(payload.range_end if payload else 0),
            workspace_root=self.config.workspace_root,
            skills=self.config.skills,
        )


def _tool_exception_result(exc: Exception, *, failed_function_name: str = "") -> _ToolExecutionResult:
    return _ToolExecutionResult(
        f"ERROR: {_format_tool_exception(exc)}",
        failed=True,
        failed_function_name=failed_function_name,
    )


def _format_tool_exception(exc: Exception) -> str:
    if isinstance(exc, UnicodeDecodeError):
        return (
            "file content includes invalid UTF-8 bytes and this tool could not "
            "recover automatically"
        )
    return f"{type(exc).__name__}: {exc}"


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
            (
                "Use project_read_doc, project_grep, project_outline, or project_list_docs "
                "when you need SuperLeaf document context."
            ),
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
                "When the user asks you to create, write, add, or generate a new "
                "SuperLeaf project file, call project_write_text_file or "
                "project_create_text_file with a relative path and the complete file "
                "content. These tools create database-backed SuperLeaf project "
                "documents and refuse to overwrite existing files."
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
            (
                "SuperLeaf project documents, comments, selections, and edit proposals "
                "are not your local filesystem; access them through the SuperLeaf tools "
                "listed in this prompt."
            ),
            (
                "Use project_read_doc, project_grep, project_outline, or project_list_docs "
                "when you need SuperLeaf document context."
            ),
            (
                "If native MCP/function tools are available, call the SuperLeaf tool directly. "
                "Only if no direct tool channel is available, request one SuperLeaf tool by replying "
                "with exactly one marker and no prose: "
                '<superleaf_tool_call>{"name":"project_list_docs","arguments":{}}</superleaf_tool_call>. '
                "Replace name and arguments as needed."
            ),
            (
                "When the user asks you to modify a SuperLeaf document, "
                "first read the relevant text if needed, "
                "then call propose_doc_edit with original_text copied verbatim from project_read_doc, "
                "range_start/range_end as hints, replacement new_text, and a short reason."
            ),
            (
                "When the user asks you to create, write, add, or generate a new "
                "SuperLeaf project file, call project_write_text_file or "
                "project_create_text_file with a relative path and the complete file "
                "content. These tools create database-backed SuperLeaf project "
                "documents and refuse to overwrite existing files."
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
    return browser_superleaf_tools()


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

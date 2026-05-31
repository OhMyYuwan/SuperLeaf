"""Backend runner for project-scoped native Agents.

The runner intentionally receives only explicit payload data assembled by
SuperLeaf. It has no database/session handle and no filesystem access.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..database import SessionLocal
from ..models import Doc
from .agent_workspace_service import (
    AgentWorkspaceError,
    list_agent_workspace_files,
    read_agent_workspace_file,
)
from .attached_files import render_attached_files_block
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
    # Project scope for the project_* tools. Both must be set for those tools
    # to be usable; handlers re-check ownership so an Agent cannot reach docs
    # outside this (project, user) tuple.
    project_id: str = ""
    user_id: str = ""
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
    prior_messages: list[dict[str, Any]] = field(default_factory=list)
    allow_project_context: bool = False


@dataclass(slots=True)
class _ToolExecutionResult:
    content: str
    failed: bool = False
    failed_function_name: str = ""
    tool_kind: str = "workspace"
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
            },
        }

        if self.config.workspace_root and (not in_workflow_chat or allow_project_context):
            async for evt in self._stream_with_workspace_tools(
                client,
                system_prompt,
                user_prompt,
                session_id,
                payload,
                project_context_only=in_workflow_chat and allow_project_context,
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
                        "Project context tools (read-only): "
                        "use project_list_docs to discover documents in the current project, "
                        "project_outline(doc_id) for a quick heading map, "
                        "project_read_doc(doc_id, range_start?, range_end?) to read content, "
                        "and project_grep(pattern, format?) to search across the project. "
                        "These tools cannot modify documents — they exist so you can gather context "
                        "before producing your reply."
                    ),
                    (
                        "Document edit tool: when the user asks you to change the text of the "
                        "current document, call propose_doc_edit(range_start, range_end, new_text, reason?). "
                        "This proposes the change as a card in the chat — the user must click accept "
                        "to actually apply it. Do NOT paste the replacement text directly into your "
                        "markdown reply; use the tool. After proposing, give a one-line summary of the "
                        "intent. Always read the surrounding context first (project_read_doc) to make "
                        "sure your character offsets are correct."
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
    ) -> AsyncIterator[dict[str, Any]]:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            *payload.prior_messages,
            {"role": "user", "content": user_prompt},
        ]
        mcp_refs = [] if project_context_only else await discover_mcp_tools(self.config.runtime_config)
        mcp_tool_map = {ref.function_name: ref for ref in mcp_refs}
        base_tools = _project_context_tools() if project_context_only else _workspace_tools()
        tools = base_tools + [ref.definition for ref in mcp_refs]

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
                if result.side_event:
                    yield result.side_event
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id") or "tool-call",
                        "content": result.content,
                    }
                )

        yield {
            "event": "native.agent.output.delta",
            "data": {"delta": "\n\n[Tool limit reached while reading Agent workspace.]"},
        }

    async def _execute_tool(
        self,
        call: dict[str, Any],
        mcp_tool_map: dict[str, McpToolRef],
        payload: NativeRunPayload,
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
            if name == "project_list_docs":
                return self._tool_project_list_docs(args)
            if name == "project_read_doc":
                return self._tool_project_read_doc(args)
            if name == "project_grep":
                return self._tool_project_grep(args)
            if name == "project_outline":
                return self._tool_project_outline(args)
            if name == "propose_doc_edit":
                return self._tool_propose_doc_edit(args, payload)
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

    # ------------------------------------------------------------------
    # project_* tools — read-only views over the user's docs in the
    # current project. Every handler opens a short-lived session and
    # filters by (project_id, user_id) from runtime config; Agent inputs
    # never reach the WHERE clause.
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

    def _tool_propose_doc_edit(
        self,
        args: dict[str, Any],
        payload: NativeRunPayload,
    ) -> _ToolExecutionResult:
        """Surface an edit proposal to the chat UI; never writes the doc.

        Scope is locked to payload.document_id — the agent cannot target other
        docs. The handler verifies the range against the live doc, captures
        the original_text snapshot for stale detection on the frontend, and
        emits a side event the runner forwards as native.agent.edit_proposal.
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

        with SessionLocal() as db:
            doc = db.get(Doc, document_id)
            if doc is None or doc.project_id != self.config.project_id:
                return _ToolExecutionResult(
                    "ERROR: active document not found in this project", failed=True
                )
            content = doc.content or ""
        total = len(content)
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
                "name": "propose_doc_edit",
                "description": (
                    "Propose a text edit to the document currently open in this discussion. "
                    "PROPOSE ONLY — the edit is NOT applied until the user clicks accept "
                    "in the chat UI. Use this whenever the user asks you to change the text. "
                    "Always read the surrounding context first (e.g. with project_read_doc) "
                    "to compute correct character offsets. Scope is locked to the active "
                    "document; you cannot target other docs."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "range_start": {
                            "type": "integer",
                            "description": "Character offset where the replacement starts (inclusive).",
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
                            "description": "The replacement text. May be empty to delete the range.",
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

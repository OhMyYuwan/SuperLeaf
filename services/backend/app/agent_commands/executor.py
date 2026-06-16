"""Agent command dispatch."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from . import files, project, suggestions
from .context import AgentCommandContext, AgentCommandResult

CommandHandler = Callable[[Session, AgentCommandContext, dict[str, Any]], AgentCommandResult]


class AgentCommandExecutor:
    def __init__(self) -> None:
        self._handlers: dict[str, CommandHandler] = {
            "superleaf_list_projects": project.list_projects,
            "superleaf_select_project": project.select_project,
            "project_list_docs": project.list_docs,
            "project_read_doc": project.read_doc,
            "project_grep": project.grep,
            "project_outline": project.outline,
            "project_write_text_file": files.project_create_text_file,
            "project_create_text_file": files.project_create_text_file,
            "propose_doc_edit": suggestions.propose_doc_edit,
            "create_suggestion": suggestions.create_suggestion,
        }

    def execute(
        self,
        db: Session,
        ctx: AgentCommandContext,
        name: str,
        arguments: dict[str, Any] | None = None,
    ) -> AgentCommandResult:
        handler = self._handlers.get(name)
        if handler is None:
            raise HTTPException(400, f"Unknown SuperLeaf MCP tool: {name}")
        return handler(db, ctx, arguments or {})

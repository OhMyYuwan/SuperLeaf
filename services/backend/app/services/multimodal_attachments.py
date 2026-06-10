"""Multimodal attachment translator for all provider types.

This module is the single source of truth for how SuperLeaf turns FileBlob
attachments into provider-specific content blocks. It owns:
- Provider capability matrix (what formats each provider supports)
- Lazy blob loading (defer base64 until actually needed)
- Size-based routing (inline vs Files API)
- Project authorization (all FileBlob reads enforce project_id)

Four provider profiles:
- anthropic: Anthropic Messages API (type=image/document, source base64/file)
- openai_chat: OpenAI Chat Completions (native + nanobot, image_url + type=file)
- dify: Dify /files/upload → upload_file_id → files[]
- claude_cli: workspace materialization + Read/Glob allowedTools
"""

from __future__ import annotations

import base64
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

from sqlalchemy.orm import Session

from ..models import FileBlob

# Maximum size for base64 inline; above this threshold, use provider Files API
# (or degrade to omit if Files API unavailable).
# Anthropic supports up to 32MB PDF; OpenAI supports ~20MB depending on model.
DEFAULT_INLINE_THRESHOLD = 5 * 1024 * 1024  # 30 MB


class ProviderCapability(TypedDict, total=False):
    """What multimodal formats a provider accepts and how."""

    image_inline: bool  # base64 data URI or source.type=base64
    image_url: bool  # publicly accessible URL (not localhost)
    image_file_api: bool  # provider Files API upload → file_id
    pdf_inline: bool
    pdf_url: bool
    pdf_file_api: bool
    max_inline_bytes: int  # size threshold before forcing Files API


PROVIDER_CAPS: dict[str, ProviderCapability] = {
    "anthropic": {
        "image_inline": True,
        "image_url": True,
        "image_file_api": True,
        "pdf_inline": True,
        "pdf_url": True,
        "pdf_file_api": True,
        "max_inline_bytes": DEFAULT_INLINE_THRESHOLD,
    },
    "openai_chat": {  # native runner + nanobot
        "image_inline": True,
        "image_url": True,
        "image_file_api": False,  # OpenAI Files exist but not wired yet
        "pdf_inline": True,  # type=file with file_data (OpenAI 2024-12+)
        "pdf_url": False,
        "pdf_file_api": False,
        "max_inline_bytes": DEFAULT_INLINE_THRESHOLD,
    },
    "dify": {
        "image_inline": False,
        "image_url": False,
        "image_file_api": True,  # must use /files/upload
        "pdf_inline": False,
        "pdf_url": False,
        "pdf_file_api": False,  # Dify PDF requires RAG knowledge base, not chat
        "max_inline_bytes": 0,
    },
    "claude_cli": {  # claude-local / claude-direct via Local Agent Host
        "image_inline": False,
        "image_url": False,
        "image_file_api": False,
        "pdf_inline": False,
        "pdf_url": False,
        "pdf_file_api": False,
        "max_inline_bytes": 0,
    },
}


@dataclass(slots=True)
class ResolvedAttachment:
    """A single attachment resolved from frontend file_id to backend blob."""

    file_id: str
    name: str
    mime: str
    size_bytes: int
    kind: Literal["image", "document", "audio", "unsupported"]
    blob_loader: Callable[[], bytes]  # lazy; only called when encoding needed
    upload_id: str | None = None  # provider Files API result (if used)


def classify_mime(mime: str) -> Literal["image", "document", "audio", "unsupported"]:
    """Classify MIME type into multimodal category."""
    mime_lower = mime.lower()
    if mime_lower.startswith("image/"):
        return "image"
    if mime_lower == "application/pdf":
        return "document"
    if mime_lower.startswith("audio/"):
        return "audio"
    return "unsupported"


def resolve_multimodal_attachments(
    attached_files: list[dict[str, Any]],
    provider_kind: str,
    db: Session,
    project_id: str,
) -> list[ResolvedAttachment]:
    """Turn frontend attached_files into backend ResolvedAttachment list.

    Args:
        attached_files: from frontend mentions.resolveAttachedFiles
        provider_kind: "anthropic" | "openai_chat" | "dify" | "claude_cli"
        db: SQLAlchemy session for FileBlob queries
        project_id: enforce project scope (authorization boundary)

    Returns:
        List of ResolvedAttachment with lazy blob_loader. Omits files that
        fail project_id check or don't exist.
    """
    out: list[ResolvedAttachment] = []
    for f in attached_files:
        if f.get("kind") != "binary":
            continue
        file_id = str(f.get("file_id") or "").strip()
        if not file_id:
            # Fallback: try parsing file_id from url field (backward compat)
            url = str(f.get("url") or "")
            if "/api/files/" in url:
                file_id = url.split("/api/files/")[-1].split("?")[0]
        if not file_id:
            continue

        # Fetch FileBlob and enforce project boundary
        blob_row = db.get(FileBlob, file_id)
        if blob_row is None or blob_row.project_id != project_id:
            # Either doesn't exist or user doesn't own it → skip silently
            # (frontend should never send cross-project file_id, but defense)
            continue

        mime = str(f.get("mime") or blob_row.mime_type or "application/octet-stream")
        kind = classify_mime(mime)
        if kind == "unsupported":
            continue

        def make_loader(row: FileBlob) -> Callable[[], bytes]:
            """Closure to defer blob read until actually needed."""

            def load() -> bytes:
                return row.blob or b""

            return load

        out.append(
            ResolvedAttachment(
                file_id=file_id,
                name=f.get("name") or blob_row.name,
                mime=mime,
                size_bytes=f.get("original_size_bytes") or blob_row.size_bytes,
                kind=kind,
                blob_loader=make_loader(blob_row),
            )
        )
    return out


def to_anthropic_content_blocks(
    attachments: list[ResolvedAttachment],
) -> list[dict[str, Any]]:
    """Translate to Anthropic Messages API content blocks.

    Schema:
        {"type": "image", "source": {"type": "base64", "media_type": "...", "data": "..."}}
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "..."}}

    Returns empty list if provider doesn't support any attachments.
    """
    caps = PROVIDER_CAPS.get("anthropic", {})
    blocks: list[dict[str, Any]] = []
    for att in attachments:
        if att.kind == "image" and caps.get("image_inline"):
            if att.size_bytes <= caps.get("max_inline_bytes", DEFAULT_INLINE_THRESHOLD):
                blob = att.blob_loader()
                b64 = base64.b64encode(blob).decode("ascii")
                blocks.append(
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": att.mime, "data": b64},
                    }
                )
        elif att.kind == "document" and caps.get("pdf_inline"):
            if att.size_bytes <= caps.get("max_inline_bytes", DEFAULT_INLINE_THRESHOLD):
                blob = att.blob_loader()
                b64 = base64.b64encode(blob).decode("ascii")
                blocks.append(
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "application/pdf",
                            "data": b64,
                        },
                    }
                )
    return blocks


def to_openai_chat_content_parts(
    attachments: list[ResolvedAttachment],
) -> list[dict[str, Any]]:
    """Translate to OpenAI Chat Completions content parts.

    Schema:
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
        {"type": "file", "file": {"filename": "x.pdf", "file_data": "data:application/pdf;base64,..."}}

    Returns empty list if provider doesn't support any attachments.
    """
    caps = PROVIDER_CAPS.get("openai_chat", {})
    parts: list[dict[str, Any]] = []
    for att in attachments:
        if att.kind == "image" and caps.get("image_inline"):
            if att.size_bytes <= caps.get("max_inline_bytes", DEFAULT_INLINE_THRESHOLD):
                blob = att.blob_loader()
                b64 = base64.b64encode(blob).decode("ascii")
                data_uri = f"data:{att.mime};base64,{b64}"
                parts.append({"type": "image_url", "image_url": {"url": data_uri}})
        elif att.kind == "document" and caps.get("pdf_inline"):
            if att.size_bytes <= caps.get("max_inline_bytes", DEFAULT_INLINE_THRESHOLD):
                blob = att.blob_loader()
                b64 = base64.b64encode(blob).decode("ascii")
                data_uri = f"data:application/pdf;base64,{b64}"
                parts.append(
                    {
                        "type": "file",
                        "file": {"filename": att.name, "file_data": data_uri},
                    }
                )
    return parts


def to_dify_files_payload(
    attachments: list[ResolvedAttachment],
) -> list[dict[str, Any]]:
    """Translate to Dify chat-messages files[] payload.

    Dify requires pre-upload via /files/upload; this function assumes
    att.upload_id is already populated by the caller.

    Schema:
        [{"type": "image", "transfer_method": "local_file", "upload_file_id": "..."}]

    Returns empty list if no uploads succeeded or provider doesn't support.
    """
    caps = PROVIDER_CAPS.get("dify", {})
    if not caps.get("image_file_api"):
        return []
    files: list[dict[str, Any]] = []
    for att in attachments:
        if att.kind == "image" and att.upload_id:
            files.append(
                {
                    "type": "image",
                    "transfer_method": "local_file",
                    "upload_file_id": att.upload_id,
                }
            )
    return files


def materialize_attachments_to_workspace(
    attachments: list[ResolvedAttachment],
    workspace_path: str,
    run_id: str,
) -> list[str]:
    """Write attachments to workspace/.superleaf-attachments/<run_id>/<name>.

    Returns list of workspace-relative paths for Claude CLI to Read.
    Caller must clean up the temp directory after turn completes.
    """
    import os
    import re

    out_dir = os.path.join(workspace_path, ".superleaf-attachments", run_id)
    os.makedirs(out_dir, exist_ok=True)
    paths: list[str] = []
    for att in attachments:
        # Sanitize filename to prevent path traversal
        safe_name = re.sub(r"[^\w\-.]", "_", att.name)
        target = os.path.join(out_dir, safe_name)
        with open(target, "wb") as f:
            f.write(att.blob_loader())
        rel_path = os.path.relpath(target, workspace_path)
        paths.append(rel_path)
    return paths

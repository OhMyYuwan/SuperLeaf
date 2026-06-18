"""MarkItDown document extraction service.

Wraps Microsoft MarkItDown as a SuperLeaf internal service,
providing controlled DOCX/PPTX → Markdown extraction.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from typing import BinaryIO

from markitdown import (
    FileConversionException,
    MarkItDown,
    MissingDependencyException,
    StreamInfo,
    UnsupportedFormatException,
)

logger = logging.getLogger(__name__)

# Lazily initialised global instance
_markitdown_instance: MarkItDown | None = None

# Hard whitelist — Phase 1 only
_SUPPORTED_EXTENSIONS: frozenset[str] = frozenset({".docx", ".pptx"})


def _get_markitdown() -> MarkItDown:
    """Return or create the global MarkItDown instance (lazy init)."""
    global _markitdown_instance
    if _markitdown_instance is None:
        _markitdown_instance = MarkItDown(enable_plugins=False)
        logger.info("MarkItDown instance initialised")
    return _markitdown_instance


def reset_markitdown() -> None:
    """Reset the global instance (for testing)."""
    global _markitdown_instance
    _markitdown_instance = None


@dataclass(frozen=True)
class MarkdownExtractionResult:
    """Result of a Markdown extraction."""

    markdown: str
    title: str | None
    source_filename: str
    source_mime_type: str


class MarkItDownService:
    """Document → Markdown extraction service.

    Wraps the MarkItDown library, adapting it to SuperLeaf's FileBlob
    storage model.  All public entry-points enforce the .docx/.pptx
    whitelist before delegating to MarkItDown.
    """

    def __init__(self, md: MarkItDown | None = None) -> None:
        self._md = md or _get_markitdown()

    # ── Core extraction ────────────────────────────────────

    def extract_file_blob(
        self,
        blob: bytes,
        filename: str,
        mime_type: str = "application/octet-stream",
    ) -> MarkdownExtractionResult:
        """Extract a DOCX/PPTX FileBlob's binary content to Markdown.

        Args:
            blob: Raw file bytes.
            filename: File name with extension (used for format detection).
            mime_type: MIME type (辅助 detection).

        Returns:
            MarkdownExtractionResult with markdown text and metadata.

        Raises:
            UnsupportedFormatException: File not in .docx/.pptx whitelist.
            FileConversionException: MarkItDown conversion failed.
        """
        self._ensure_supported(filename)
        stream = io.BytesIO(blob)
        stream_info = StreamInfo(mimetype=mime_type, filename=filename)
        return self._extract_stream(stream, stream_info, filename, mime_type)

    def extract_stream(
        self,
        stream: BinaryIO,
        filename: str | None = None,
        mime_type: str | None = None,
    ) -> MarkdownExtractionResult:
        """Extract Markdown from a binary stream.

        Suitable for streaming uploads to avoid loading the entire file
        into memory at once.
        """
        self._ensure_supported(filename or "")
        stream_info = StreamInfo(mimetype=mime_type, filename=filename)
        return self._extract_stream(
            stream,
            stream_info,
            filename or "unknown",
            mime_type or "application/octet-stream",
        )

    # ── Format detection ───────────────────────────────────

    def is_supported(self, filename: str) -> bool:
        """Check whether *filename* is in the Phase-1 whitelist."""
        ext = _extract_extension(filename)
        return ext in _SUPPORTED_EXTENSIONS

    def _ensure_supported(self, filename: str) -> None:
        """Raise if *filename* bypasses the DOCX/PPTX whitelist."""
        if not self.is_supported(filename):
            raise UnsupportedFormatException(
                f"Unsupported file format: {filename}. "
                "Only .docx and .pptx are supported."
            )

    # ── Internal ───────────────────────────────────────────

    def _extract_stream(
        self,
        stream: BinaryIO,
        stream_info: StreamInfo,
        filename: str,
        mime_type: str,
    ) -> MarkdownExtractionResult:
        try:
            result = self._md.convert_stream(stream, stream_info=stream_info)
            return MarkdownExtractionResult(
                markdown=result.markdown,
                title=result.title,
                source_filename=filename,
                source_mime_type=mime_type,
            )
        except UnsupportedFormatException:
            logger.warning("Unsupported format: %s (%s)", filename, mime_type)
            raise
        except MissingDependencyException as exc:
            logger.error("Missing dependency for %s: %s", filename, exc)
            raise
        except FileConversionException as exc:
            logger.error("Conversion failed for %s: %s", filename, exc)
            raise


def _extract_extension(filename: str) -> str:
    """Return the lowercase extension including the dot, or ''."""
    if "." in filename:
        return "." + filename.rsplit(".", 1)[-1].lower()
    return ""

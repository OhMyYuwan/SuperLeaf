"""Helpers for weaving @-mentioned files into agent prompts.

The frontend ships attached files in `inputs.attached_files`:

    [
      {
        "name": "methods.tex",
        "path": "chapters/methods.tex",
        "kind": "doc",
        "content": "<file body>",
        "truncated": false,
        "original_size_bytes": 2456,
      },
      {
        "name": "results.png",
        "path": "figures/results.png",
        "kind": "binary",
        "mime": "image/png",
        "url": "http://localhost:8000/api/files/xyz",
        "original_size_bytes": 122880,
      },
    ]

We re-enforce defensive caps server-side and emit a structured block that is
appended to the agent query. Binary files are handled separately by the
caller (Nanobot multimodal path); here we just emit a metadata line so the
text-only prompt stays self-describing.
"""

from __future__ import annotations

from typing import Any

# Defensive caps. Frontend already truncates to lower numbers (50 KB / 200 KB),
# but we re-check here in case the client is buggy or malicious.
PER_FILE_CAP_BYTES = 80 * 1024
TOTAL_BUDGET_BYTES = 320 * 1024
MAX_ATTACHED_FILES = 10


def normalize_attached_files(raw: Any) -> list[dict[str, Any]]:
    """Validate + clip the inbound attached_files list to defensive caps."""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    used = 0
    for entry in raw[:MAX_ATTACHED_FILES]:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        kind = str(entry.get("kind") or "").strip()
        if not name or kind not in ("doc", "binary"):
            continue
        item: dict[str, Any] = {
            "name": name,
            "path": str(entry.get("path") or name),
            "kind": kind,
            "original_size_bytes": int(entry.get("original_size_bytes") or 0),
        }
        if entry.get("omitted"):
            item["omitted"] = True
            item["omit_reason"] = str(entry.get("omit_reason") or "omitted by client")
            out.append(item)
            continue
        if kind == "doc":
            content = str(entry.get("content") or "")
            encoded = content.encode("utf-8")
            if len(encoded) > PER_FILE_CAP_BYTES:
                content = encoded[:PER_FILE_CAP_BYTES].decode("utf-8", errors="ignore")
                content += f"\n[...server-side truncation to {PER_FILE_CAP_BYTES // 1024} KB]"
                item["truncated"] = True
            else:
                item["truncated"] = bool(entry.get("truncated", False))
            cost = len(content.encode("utf-8"))
            if used + cost > TOTAL_BUDGET_BYTES:
                item["omitted"] = True
                item["omit_reason"] = "server total budget exceeded"
            else:
                used += cost
                item["content"] = content
        else:  # binary
            mime = str(entry.get("mime") or "application/octet-stream")
            url = str(entry.get("url") or "")
            item["mime"] = mime
            item["url"] = url
        out.append(item)
    return out


def render_attached_files_block(files: list[dict[str, Any]]) -> str:
    """Render the [ATTACHED FILES] block injected before the user message."""
    if not files:
        return ""
    parts: list[str] = ["[ATTACHED FILES]"]
    for f in files:
        header_bits = [f"[FILE: {f['name']}", f"kind={f['kind']}"]
        header_bits.append(f"size={f['original_size_bytes']}B")
        if f.get("truncated"):
            header_bits.append("truncated=true")
        if f["kind"] == "binary":
            if f.get("mime"):
                header_bits.append(f"mime={f['mime']}")
            if f.get("url"):
                header_bits.append(f"url={f['url']}")
        parts.append(" | ".join(header_bits) + "]")
        if f.get("omitted"):
            parts.append(f"[file omitted: {f.get('omit_reason', 'unknown')}]")
        elif f["kind"] == "doc":
            parts.append(f.get("content", ""))
        else:
            parts.append("(二进制文件已通过多模态附件传递；若 Agent 不支持视觉则只看到此元数据)")
        parts.append(f"[END FILE: {f['name']}]")
    parts.append("[END ATTACHED FILES]")
    return "\n".join(parts)


def collect_image_attachments(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return binary attachments that look like images, for multimodal forwarding."""
    out: list[dict[str, Any]] = []
    for f in files:
        if f.get("kind") != "binary":
            continue
        mime = str(f.get("mime") or "")
        url = str(f.get("url") or "")
        if not url:
            continue
        if mime.startswith("image/"):
            out.append({"url": url, "mime": mime, "name": f.get("name", "image")})
    return out

"""Metadata helpers for Skills that are installed lazily through npx."""

from __future__ import annotations

import urllib.parse


RECIPE_PREFIX = "ylw:recipe-"
CATALOG_PREFIX = "ylw:catalog-"


def build_recipe_tags(
    *,
    source: str,
    repo_url: str = "",
    source_url: str = "",
    source_ref: str = "",
    skill_name: str = "",
    install_command: str = "",
    marketplace_id: str = "",
    catalog_version: str = "",
    catalog_author: str = "",
    catalog_checksum: str = "",
    base_tags: list[str] | None = None,
) -> list[str]:
    tags = [tag for tag in base_tags or [] if not str(tag).startswith(("ylw:recipe-", "ylw:catalog-"))]
    pairs = {
        "recipe-source": source,
        "recipe-repo-url": repo_url,
        "recipe-source-url": source_url,
        "recipe-source-ref": source_ref,
        "recipe-skill-name": skill_name,
        "recipe-install-command": install_command,
        "catalog-id": marketplace_id,
        "catalog-version": catalog_version,
        "catalog-author": catalog_author,
        "catalog-checksum": catalog_checksum,
    }
    for key, value in pairs.items():
        cleaned = str(value or "").strip()
        if cleaned:
            tags.append(f"ylw:{key}={cleaned}")
    return tags


def recipe_meta_from_tags(tags: list[str] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for tag in tags or []:
        text = str(tag)
        if not text.startswith("ylw:") or "=" not in text:
            continue
        key, value = text[4:].split("=", 1)
        out[key] = value
    return {
        "source": out.get("recipe-source", ""),
        "repo_url": out.get("recipe-repo-url", ""),
        "source_url": out.get("recipe-source-url", ""),
        "source_ref": out.get("recipe-source-ref", ""),
        "skill_name": out.get("recipe-skill-name", ""),
        "install_command": out.get("recipe-install-command", ""),
        "marketplace_id": out.get("catalog-id", ""),
        "catalog_version": out.get("catalog-version", ""),
        "catalog_author": out.get("catalog-author", ""),
        "catalog_checksum": out.get("catalog-checksum", ""),
    }


def build_npx_install_command(source_url: str, skill_name: str = "") -> str:
    source = str(source_url or "").strip()
    if not source:
        return ""
    parts = ["npx", "--yes", "skills", "add", source]
    if skill_name and not is_direct_skill_source(source):
        parts.extend(["--skill", skill_name])
    parts.extend(["--agent", "codex", "--copy", "--yes"])
    return " ".join(_shell_quote(part) for part in parts)


def is_direct_skill_source(value: str) -> bool:
    parsed = urllib.parse.urlparse(str(value or ""))
    return parsed.netloc == "github.com" and "/tree/" in parsed.path


def _shell_quote(value: str) -> str:
    if value and all(ch.isalnum() or ch in "/:._@=-" for ch in value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"

"""Static Skill marketplace sync and local recipe registration.

The marketplace is served as GitHub Pages/static files. Runtime Agent
execution never reads from the marketplace directly; installed marketplace
items become local Skill recipe rows first, then Agent setup executes npx.
"""

from __future__ import annotations

import json
import shlex
import urllib.parse
from dataclasses import dataclass
from datetime import datetime

import httpx

from sqlalchemy.orm import Session

from ..models import Skill
from ..settings import settings
from .mcp_policy import validate_remote_endpoint
from .project_fs_service import ProjectFsService
from .project_service import ProjectService
from .safe_http import SsrfPolicyError, safe_fetch_text
from .skill_recipe_metadata import (
    build_npx_install_command,
    build_recipe_tags,
    recipe_meta_from_tags,
)


class SkillMarketplaceError(RuntimeError):
    pass


@dataclass(frozen=True)
class MarketplaceEntry:
    id: str
    name: str
    display_name: str
    version: str
    author_github: str
    description: str
    tags: list[str]
    license: str
    path: str
    entry: str
    skill_url: str
    entry_url: str
    readme_url: str
    checksum_sha256: str
    repo_url: str
    source_url: str
    source_ref: str
    skill_name: str
    install_command: str
    installed: bool = False
    installed_skill_id: str | None = None
    installed_version: str = ""
    update_available: bool = False


class SkillMarketplaceService:
    def __init__(self, db: Session, *, catalog_url: str | None = None) -> None:
        self.db = db
        self.catalog_url = (catalog_url or settings.skill_marketplace_url).strip()

    def list_entries(self, *, user_id: str) -> list[MarketplaceEntry]:
        payload = self._fetch_catalog()
        raw_entries = list(payload.get("skills", []))
        raw_entries.extend(self._fetch_external_catalog_entries())
        entries = _dedupe_entries([self._entry_from_raw(raw) for raw in raw_entries])
        installed = self._installed_by_catalog_id(user_id=user_id)
        out: list[MarketplaceEntry] = []
        for entry in entries:
            row = installed.get(entry.id)
            if row is None:
                out.append(entry)
                continue
            installed_version = _catalog_meta(row).get("version", "")
            out.append(
                MarketplaceEntry(
                    **{
                        **entry.__dict__,
                        "installed": True,
                        "installed_skill_id": row.id,
                        "installed_version": installed_version,
                        "update_available": _version_key(entry.version) > _version_key(installed_version),
                    }
                )
            )
        return out

    def install(self, skill_id: str, *, user_id: str) -> tuple[Skill, MarketplaceEntry]:
        entry = self._find_entry(skill_id, user_id=user_id)
        now = datetime.utcnow()
        existing = self._installed_by_catalog_id(user_id=user_id).get(entry.id)
        tags = build_recipe_tags(
            source="marketplace",
            repo_url=entry.repo_url,
            source_url=entry.source_url,
            source_ref=entry.source_ref,
            skill_name=entry.skill_name,
            install_command=entry.install_command,
            marketplace_id=entry.id,
            catalog_version=entry.version,
            catalog_author=entry.author_github,
            catalog_checksum=entry.checksum_sha256,
            base_tags=entry.tags,
        )
        if existing is None:
            row = Skill(
                owner_user_id=user_id,
                name=entry.name or entry.display_name or entry.id,
                public_name=entry.id,
                description=entry.description,
                content="",
                visibility="private",
                source="marketplace",
                version=1,
                tags=tags,
                created_at=now,
                updated_at=now,
            )
            self.db.add(row)
        else:
            row = existing
            row.name = entry.name or entry.display_name or entry.id
            row.public_name = entry.id
            row.description = entry.description
            row.content = ""
            row.visibility = "private"
            row.source = "marketplace"
            row.tags = tags
            row.version += 1
            row.updated_at = now
        self.db.commit()
        self.db.refresh(row)
        installed_entry = MarketplaceEntry(
            **{
                **entry.__dict__,
                "installed": True,
                "installed_skill_id": row.id,
                "installed_version": entry.version,
                "update_available": False,
            }
        )
        return row, installed_entry

    def uninstall(self, skill_id: str, *, user_id: str) -> bool:
        row = self._installed_by_catalog_id(user_id=user_id).get(skill_id)
        if row is None:
            return False
        self.db.delete(row)
        self.db.commit()
        return True

    def clone_to_local(self, skill_id: str, *, user_id: str, name: str = ""):
        """Fetch SKILL.md from marketplace catalog and create an editable Skill Project.

        Returns the new project-backed Skill row. The marketplace installation
        is removed after the project cache is created successfully.

        Args:
            name: User-provided name for the local copy. If empty, falls back to
                  the marketplace entry's display_name.
        """
        from .native_agent_service import NativeAgentService

        installed = self._installed_by_catalog_id(user_id=user_id)
        if skill_id not in installed:
            raise SkillMarketplaceError("marketplace skill install not found")
        entry = self._find_entry(skill_id, user_id=user_id)

        content = self._fetch_text(entry.entry_url)
        if not content.strip():
            raise SkillMarketplaceError("无法从市场仓库获取 SKILL.md 内容")

        local_name = name.strip() or entry.display_name or entry.name or entry.id
        project = ProjectService(self.db).create(user_id=user_id, name=local_name, project_type="skill")
        project_fs = ProjectFsService(self.db, project)
        project_fs.create_doc(
            folder_id=None,
            name="README.md",
            format="md",
            content=self._clone_readme(entry, local_name=local_name),
        )
        project_fs.create_doc(folder_id=None, name="SKILL.md", format="md", content=content)

        local_skill = NativeAgentService(self.db).update_project_skill_cache(project, user_id=user_id)
        local_skill.description = entry.description or local_skill.description
        local_skill.tags = _local_project_clone_tags(entry, local_skill.tags)
        self.db.add(local_skill)
        self.db.commit()
        self.db.refresh(local_skill)

        self.uninstall(skill_id, user_id=user_id)
        return local_skill

    def _clone_readme(self, entry: MarketplaceEntry, *, local_name: str) -> str:
        readme = ""
        if entry.readme_url:
            try:
                readme = self._fetch_text(entry.readme_url).strip()
            except SkillMarketplaceError:
                readme = ""
        if readme:
            return readme + "\n\n" + _clone_source_section(entry)
        title = local_name.strip() or entry.display_name or entry.name or entry.id
        description = entry.description.strip() or "Editable local copy of a marketplace Skill."
        return f"# {title}\n\n{description}\n\n{_clone_source_section(entry)}"

    def _find_entry(self, skill_id: str, *, user_id: str) -> MarketplaceEntry:
        for entry in self.list_entries(user_id=user_id):
            if entry.id == skill_id:
                return entry
        raise SkillMarketplaceError("Skill not found in marketplace")

    def _fetch_catalog(self) -> dict:
        if not self.catalog_url:
            raise SkillMarketplaceError("Skill marketplace URL is not configured")
        return json.loads(self._fetch_text(self.catalog_url))

    def _fetch_external_catalog_entries(self) -> list[dict]:
        try:
            payload = json.loads(self._fetch_text("external-skills.json"))
        except SkillMarketplaceError as exc:
            if "HTTP 404" in str(exc):
                return []
            raise
        return [_external_entry_from_raw(raw) for raw in payload.get("skills", [])]

    def _fetch_text(self, url_or_path: str) -> str:
        url = urllib.parse.urljoin(self.catalog_url, url_or_path)
        try:
            validate_remote_endpoint(url)
        except ValueError as exc:
            raise SkillMarketplaceError(f"Blocked Skill marketplace URL {url}: {exc}") from exc
        try:
            return safe_fetch_text(
                url,
                headers={"Accept": "application/json,text/plain,*/*", "User-Agent": "SuperLeaf"},
                timeout=20,
                allow_private=settings.mcp_remote_private_networks_enabled,
            )
        except SsrfPolicyError as exc:
            raise SkillMarketplaceError(f"Blocked Skill marketplace URL {url}: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            raise SkillMarketplaceError(
                f"Skill marketplace request failed: HTTP {exc.response.status_code}"
            ) from exc
        except Exception as exc:  # pragma: no cover - runtime/network path
            raise SkillMarketplaceError(f"Skill marketplace request failed: {exc}") from exc

    def _entry_from_raw(self, raw: dict) -> MarketplaceEntry:
        path = str(raw.get("path") or "").strip()
        entry = str(raw.get("entry") or "SKILL.md").strip()
        skill_url = str(raw.get("skill_url") or f"{path}/skill.yaml").strip()
        entry_url = str(raw.get("entry_url") or f"{path}/{entry}").strip()
        repo_url, source_ref = _repo_from_catalog(self.catalog_url, raw)
        source_url = str(raw.get("source_url") or _source_url(repo_url, source_ref, path)).strip()
        skill_name = str(raw.get("skill_name") or raw.get("name") or "").strip()
        install_command = str(
            raw.get("install_command") or _install_command(source_url or repo_url, skill_name)
        ).strip()
        return MarketplaceEntry(
            id=str(raw.get("id") or "").strip(),
            name=str(raw.get("name") or "").strip(),
            display_name=str(raw.get("display_name") or raw.get("name") or "").strip(),
            version=str(raw.get("version") or "").strip(),
            author_github=str(raw.get("author_github") or "").strip(),
            description=str(raw.get("description") or "").strip(),
            tags=[str(tag).strip() for tag in raw.get("tags", []) if str(tag).strip()],
            license=str(raw.get("license") or "").strip(),
            path=path,
            entry=entry,
            skill_url=skill_url,
            entry_url=entry_url,
            readme_url=str(raw.get("readme_url") or "").strip(),
            checksum_sha256=str(raw.get("checksum_sha256") or "").strip(),
            repo_url=repo_url,
            source_url=source_url,
            source_ref=source_ref,
            skill_name=skill_name,
            install_command=install_command,
        )

    def _installed_by_catalog_id(self, *, user_id: str) -> dict[str, Skill]:
        rows = (
            self.db.query(Skill)
            .filter(Skill.owner_user_id == user_id, Skill.source == "marketplace")
            .all()
        )
        out: dict[str, Skill] = {}
        for row in rows:
            catalog_id = _catalog_meta(row).get("id") or row.public_name
            if catalog_id:
                out[catalog_id] = row
        return out


def _catalog_meta(row: Skill) -> dict[str, str]:
    meta = recipe_meta_from_tags(row.tags)
    return {
        "id": meta.get("marketplace_id", ""),
        "version": meta.get("catalog_version", ""),
        "author": meta.get("catalog_author", ""),
        "checksum": meta.get("catalog_checksum", ""),
    }


def _version_key(value: str) -> tuple[int, int, int]:
    parts = []
    for part in (value or "0.0.0").split(".")[:3]:
        try:
            parts.append(int(part))
        except ValueError:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)  # type: ignore[return-value]


def _dedupe_entries(entries: list[MarketplaceEntry]) -> list[MarketplaceEntry]:
    out: list[MarketplaceEntry] = []
    seen: set[str] = set()
    for entry in entries:
        if not entry.id or entry.id in seen:
            continue
        seen.add(entry.id)
        out.append(entry)
    return out


def _clone_source_section(entry: MarketplaceEntry) -> str:
    lines = [
        "## Marketplace Source",
        "",
        f"- Marketplace ID: `{entry.id}`",
    ]
    if entry.version:
        lines.append(f"- Version: `{entry.version}`")
    if entry.author_github:
        lines.append(f"- Author: `{entry.author_github}`")
    if entry.source_url:
        lines.append(f"- Source: {entry.source_url}")
    elif entry.repo_url:
        lines.append(f"- Source: {entry.repo_url}")
    lines.append("")
    lines.append(
        "This project is an editable local copy. Update the Skill cache from the project version panel "
        "after changing files."
    )
    return "\n".join(lines)


def _local_project_clone_tags(entry: MarketplaceEntry, current_tags: list | None) -> list[str]:
    tags = [str(tag).strip() for tag in (current_tags or []) if str(tag).strip()]
    for tag in ["marketplace-copy", *entry.tags]:
        clean = str(tag).strip()
        if clean and clean not in tags:
            tags.append(clean)
    return tags


def _external_entry_from_raw(raw: dict) -> dict:
    author = str(raw.get("author_github") or raw.get("author") or "").strip()
    skill_name = str(raw.get("skill_name") or raw.get("name") or "").strip()
    install_command = str(raw.get("npx_command") or raw.get("install_command") or "").strip()
    source_url, command_skill_name = _parse_npx_skill_add(install_command)
    resolved_skill_name = command_skill_name or skill_name
    return {
        "id": str(raw.get("id") or f"{author}@{skill_name}").strip(),
        "name": skill_name,
        "display_name": str(raw.get("display_name") or skill_name).strip(),
        "version": str(raw.get("version") or "1.0.0").strip(),
        "author_github": author,
        "description": str(raw.get("description") or "").strip(),
        "tags": [str(tag).strip() for tag in raw.get("tags", []) if str(tag).strip()],
        "license": str(raw.get("license") or "").strip(),
        "path": "",
        "entry": "npx",
        "skill_url": "",
        "entry_url": source_url,
        "readme_url": "",
        "checksum_sha256": "",
        "repo_url": source_url,
        "source_url": source_url,
        "source_ref": str(raw.get("source_ref") or "").strip(),
        "skill_name": resolved_skill_name,
        "install_command": _normalize_npx_install_command(install_command),
    }


def _parse_npx_skill_add(command: str) -> tuple[str, str]:
    try:
        parts = shlex.split(str(command or ""))
    except ValueError:
        return "", ""
    for idx in range(len(parts) - 2):
        if parts[idx] != "skills" or parts[idx + 1] != "add":
            continue
        source_url = parts[idx + 2]
        skill_name = ""
        rest = parts[idx + 3 :]
        for opt_idx, item in enumerate(rest):
            if item == "--skill" and opt_idx + 1 < len(rest):
                skill_name = rest[opt_idx + 1]
                break
            if item.startswith("--skill="):
                skill_name = item.split("=", 1)[1]
                break
        return source_url, skill_name
    return "", ""


def _normalize_npx_install_command(command: str) -> str:
    try:
        parts = shlex.split(str(command or ""))
    except ValueError:
        return str(command or "").strip()
    if not parts:
        return ""
    if parts[0] == "npx" and (len(parts) == 1 or parts[1] != "--yes"):
        parts.insert(1, "--yes")
    if "--agent" not in parts:
        parts.extend(["--agent", "codex"])
    if "--copy" not in parts:
        parts.append("--copy")
    if parts[-1] != "--yes":
        parts.append("--yes")
    return " ".join(_shell_quote(part) for part in parts)


def _shell_quote(value: str) -> str:
    if value and all(ch.isalnum() or ch in "/:._@=-" for ch in value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _repo_from_catalog(catalog_url: str, raw: dict) -> tuple[str, str]:
    repo_url = str(raw.get("repo_url") or "").strip()
    source_ref = str(raw.get("source_ref") or raw.get("ref") or "").strip()
    if repo_url:
        return repo_url, source_ref

    parsed = urllib.parse.urlparse(catalog_url)
    parts = [p for p in parsed.path.split("/") if p]
    if parsed.netloc == "raw.githubusercontent.com" and len(parts) >= 3:
        owner, repo, ref = parts[0], parts[1], parts[2]
        return f"https://github.com/{owner}/{repo}.git", source_ref or ref
    if parsed.netloc == "github.com" and len(parts) >= 2:
        owner, repo = parts[0], parts[1].removesuffix(".git")
        return f"https://github.com/{owner}/{repo}.git", source_ref
    return "", source_ref


def _install_command(repo_url: str, skill_name: str) -> str:
    return build_npx_install_command(repo_url, skill_name)


def _source_url(repo_url: str, source_ref: str, path: str) -> str:
    if not repo_url or not path:
        return ""
    parsed = urllib.parse.urlparse(repo_url)
    if parsed.netloc != "github.com":
        return repo_url
    cleaned_path = parsed.path.removesuffix(".git").strip("/")
    if "/" not in cleaned_path:
        return repo_url
    ref = source_ref or "main"
    return f"https://github.com/{cleaned_path}/tree/{urllib.parse.quote(ref)}/{path.strip('/')}"

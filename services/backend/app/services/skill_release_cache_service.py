"""Skill release artifact cache and resolver.

Shared releases are immutable content-addressed folders under server storage.
Private Skills stay user scoped and are resolved only for their owner.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from uuid import uuid4
import json
import os
import shutil

import yaml
from sqlalchemy.orm import Session

from ..models import Skill, SkillRelease
from ..settings import settings
from .skill_content_crypto import decrypt_skill_content

SAFE_TEXT_SUFFIXES = {
    ".md",
    ".mdx",
    ".txt",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".csv",
    ".tsv",
    ".py",
    ".js",
    ".ts",
    ".tsx",
}
FORBIDDEN_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", "build"}
IGNORED_METADATA_NAMES = {".DS_Store", "Thumbs.db"}
SERVER_VISIBILITIES = {"public", "unlisted", "system"}


@dataclass(slots=True)
class ResolvedSkillRef:
    alias: str
    target_path: Path
    manifest: dict
    storage_scope: str
    source: str
    skill_id: str
    name: str
    description: str = ""
    version: str = ""
    checksum: str = ""
    release_id: str = ""


class SkillReleaseCacheError(ValueError):
    pass


class SkillReleaseCacheService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def publish_folder(
        self,
        *,
        namespace: str,
        slug: str,
        version: str,
        display_name: str,
        visibility: str,
        source_dir: Path,
        publisher_user_id: str = "",
        description: str = "",
        install_spec: str = "",
        source_skill_id: str = "",
        source_type: str = "marketplace",
        commit: bool = True,
    ) -> SkillRelease:
        visibility_clean = _clean_visibility(visibility)
        if visibility_clean not in SERVER_VISIBILITIES:
            raise SkillReleaseCacheError("only public, unlisted, or system releases can use server cache")

        source = Path(source_dir).resolve()
        if not source.is_dir() or not (source / "SKILL.md").is_file():
            raise SkillReleaseCacheError("Skill release folder must contain SKILL.md")

        checksum, manifest = build_skill_folder_manifest(source)
        namespace_clean = _safe_slug(namespace, fallback="official")
        slug_clean = _safe_slug(slug, fallback="skill")
        version_clean = str(version or "").strip() or "0.0.0"
        existing = (
            self.db.query(SkillRelease)
            .filter(
                SkillRelease.namespace == namespace_clean,
                SkillRelease.slug == slug_clean,
                SkillRelease.version == version_clean,
            )
            .first()
        )
        if existing is not None:
            if existing.artifact_checksum != checksum:
                raise SkillReleaseCacheError(
                    "skill release version already exists with different content"
                )
            return existing

        rel_artifact = _server_artifact_relpath(checksum)
        artifact = settings.data_dir / rel_artifact
        if not artifact.exists():
            _copy_skill_folder(source, artifact)
            (artifact / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

        now = datetime.utcnow()
        row = SkillRelease(
            namespace=namespace_clean,
            slug=slug_clean,
            display_name=display_name.strip() or slug.strip() or "Skill",
            description=description.strip() or str(manifest.get("description") or ""),
            version=version_clean,
            visibility=visibility_clean,
            storage_scope="server",
            artifact_checksum=checksum,
            artifact_path=rel_artifact.as_posix(),
            source_type=source_type.strip() or "marketplace",
            source_skill_id=source_skill_id.strip(),
            publisher_user_id=publisher_user_id.strip(),
            install_spec=install_spec.strip(),
            manifest=manifest,
            created_at=now,
            updated_at=now,
        )
        self.db.add(row)
        if commit:
            self.db.commit()
            self.db.refresh(row)
        else:
            self.db.flush()
        return row

    def publish_skill(
        self,
        skill: Skill,
        *,
        namespace: str,
        slug: str = "",
        version: str = "",
        visibility: str = "public",
        publisher_user_id: str = "",
        install_spec: str = "",
        source_type: str = "user-skill",
        commit: bool = True,
    ) -> SkillRelease:
        source_dir = Path(skill.cache_path) if skill.cache_path else None
        if source_dir is not None and (source_dir / "SKILL.md").is_file():
            return self.publish_folder(
                namespace=namespace,
                slug=slug or skill.name,
                version=version or str(skill.version or 1),
                display_name=skill.public_name or skill.name,
                visibility=visibility,
                source_dir=source_dir,
                publisher_user_id=publisher_user_id,
                description=skill.description,
                install_spec=install_spec,
                source_skill_id=skill.id,
                source_type=source_type,
                commit=commit,
            )
        return self.publish_skill_content(
            namespace=namespace,
            slug=slug or skill.name,
            version=version or str(skill.version or 1),
            display_name=skill.public_name or skill.name,
            visibility=visibility,
            content=decrypt_skill_content(skill.content),
            publisher_user_id=publisher_user_id,
            description=skill.description,
            install_spec=install_spec,
            source_skill_id=skill.id,
            source_type=source_type,
            commit=commit,
        )

    def publish_skill_content(
        self,
        *,
        namespace: str,
        slug: str,
        version: str,
        display_name: str,
        visibility: str,
        content: str,
        publisher_user_id: str = "",
        description: str = "",
        install_spec: str = "",
        source_skill_id: str = "",
        source_type: str = "marketplace",
        commit: bool = True,
    ) -> SkillRelease:
        if not content.strip():
            raise SkillReleaseCacheError("skill content missing")
        tmp = (
            settings.data_dir
            / "skill-content-cache"
            / "tmp"
            / f"release-{uuid4().hex}"
        )
        try:
            tmp.mkdir(parents=True, exist_ok=False)
            (tmp / "SKILL.md").write_text(content.strip() + "\n", encoding="utf-8")
            return self.publish_folder(
                namespace=namespace,
                slug=slug,
                version=version,
                display_name=display_name,
                visibility=visibility,
                source_dir=tmp,
                publisher_user_id=publisher_user_id,
                description=description,
                install_spec=install_spec,
                source_skill_id=source_skill_id,
                source_type=source_type,
                commit=commit,
            )
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def resolve_skill_ref(self, *, user_id: str, ref: dict) -> ResolvedSkillRef:
        alias = _safe_alias(ref.get("alias") or ref.get("name") or ref.get("slug") or ref.get("skill_id") or ref.get("release_id"))
        release_id = str(ref.get("release_id") or "").strip()
        if release_id:
            release = self.db.get(SkillRelease, release_id)
            if release is None:
                raise SkillReleaseCacheError("skill release not found")
            self._ensure_release_access(release, user_id=user_id)
            target = settings.data_dir / release.artifact_path
            if not target.is_dir() or not (target / "SKILL.md").is_file():
                raise SkillReleaseCacheError("skill release artifact missing")
            return ResolvedSkillRef(
                alias=alias,
                target_path=target,
                manifest=dict(release.manifest or {}),
                storage_scope=release.storage_scope,
                source=release.source_type or "release",
                skill_id=alias,
                name=release.display_name or release.slug,
                description=release.description,
                version=release.version,
                checksum=release.artifact_checksum,
                release_id=release.id,
            )

        skill_id = str(ref.get("skill_id") or "").strip()
        if skill_id:
            return self._resolve_user_skill(skill_id, user_id=user_id, alias=alias)

        raise SkillReleaseCacheError("skill ref requires release_id or skill_id")

    def _ensure_release_access(self, release: SkillRelease, *, user_id: str) -> None:
        visibility = str(release.visibility or "").strip()
        if visibility in {"public", "unlisted", "system"}:
            return
        if visibility == "private" and release.publisher_user_id == user_id:
            return
        raise SkillReleaseCacheError("skill release not available")

    def _resolve_user_skill(self, skill_id: str, *, user_id: str, alias: str) -> ResolvedSkillRef:
        skill = self.db.get(Skill, skill_id)
        if skill is None:
            raise SkillReleaseCacheError("skill not available")
        if not (skill.owner_user_id == user_id or skill.visibility in {"public", "system"}):
            raise SkillReleaseCacheError("skill not available")

        if skill.cache_path:
            target = Path(skill.cache_path)
        else:
            target = self._materialize_user_skill_content(skill, user_id=user_id)
        if not target.is_dir() or not (target / "SKILL.md").is_file():
            raise SkillReleaseCacheError("skill cache missing")
        checksum, manifest = build_skill_folder_manifest(target)
        return ResolvedSkillRef(
            alias=alias,
            target_path=target,
            manifest=manifest,
            storage_scope="user",
            source=skill.source or "user",
            skill_id=skill.id,
            name=skill.name,
            description=skill.description,
            version=str(skill.version or 1),
            checksum=checksum,
        )

    def _materialize_user_skill_content(self, skill: Skill, *, user_id: str) -> Path:
        content = decrypt_skill_content(skill.content)
        if not content.strip():
            raise SkillReleaseCacheError("skill content missing")
        root = settings.data_dir / "skills-cache" / "users" / _safe_slug(user_id, fallback="user") / "content" / _safe_slug(skill.id, fallback="skill")
        version_dir = root / str(skill.version or 1)
        version_dir.mkdir(parents=True, exist_ok=True)
        skill_md = version_dir / "SKILL.md"
        if not skill_md.exists() or skill_md.read_text(encoding="utf-8", errors="replace") != content:
            skill_md.write_text(content.strip() + "\n", encoding="utf-8")
        return version_dir


def build_skill_folder_manifest(folder: Path) -> tuple[str, dict]:
    root = Path(folder).resolve()
    files: list[dict] = []
    digest = sha256()
    total_bytes = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if rel.name == "manifest.json" or _is_unsafe_path(rel) or not _is_safe_text_file(path):
            continue
        data = path.read_bytes()
        rel_posix = rel.as_posix()
        digest.update(rel_posix.encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
        total_bytes += len(data)
        files.append({"path": rel_posix, "size": len(data)})
    if not any(item["path"] == "SKILL.md" for item in files):
        raise SkillReleaseCacheError("Skill folder must contain SKILL.md")
    meta = _read_skill_meta(root / "SKILL.md")
    checksum = digest.hexdigest()
    return checksum, {
        "checksum": f"sha256:{checksum}",
        "name": meta.get("name", ""),
        "description": meta.get("description", ""),
        "version": meta.get("version", 1),
        "tags": meta.get("tags", []),
        "files": files,
        "file_count": len(files),
        "total_bytes": total_bytes,
    }


def _server_artifact_relpath(checksum: str) -> Path:
    return Path("skill-content-cache") / "artifacts" / "sha256" / checksum[:2] / checksum


def _copy_skill_folder(source: Path, dest: Path) -> None:
    tmp = dest.with_name(dest.name + ".tmp")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True, exist_ok=True)
    for path in sorted(source.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(source)
        if _is_unsafe_path(rel) or not _is_safe_text_file(path):
            continue
        target = tmp / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    if not (tmp / "SKILL.md").is_file():
        shutil.rmtree(tmp, ignore_errors=True)
        raise SkillReleaseCacheError("Skill copy did not preserve SKILL.md")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(tmp, ignore_errors=True)
        return
    os.replace(tmp, dest)


def _read_skill_meta(skill_md: Path) -> dict:
    text = skill_md.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---"):
        return {}
    try:
        _, frontmatter, _ = text.split("---", 2)
        raw = yaml.safe_load(frontmatter) or {}
    except (ValueError, yaml.YAMLError):
        return {}
    if not isinstance(raw, dict):
        return {}
    tags = raw.get("tags", [])
    if isinstance(tags, str):
        tags = [tags]
    return {
        "name": str(raw.get("name") or "").strip(),
        "description": str(raw.get("description") or "").strip(),
        "version": raw.get("version", 1),
        "tags": [str(tag).strip() for tag in tags if str(tag).strip()] if isinstance(tags, list) else [],
    }


def _clean_visibility(value: str) -> str:
    cleaned = str(value or "").strip() or "private"
    if cleaned not in {"public", "unlisted", "private", "system", "team", "project"}:
        raise SkillReleaseCacheError("invalid skill release visibility")
    return cleaned


def _safe_alias(value: object) -> str:
    return _safe_slug(str(value or ""), fallback="skill")


def _safe_slug(value: str, *, fallback: str) -> str:
    cleaned = "".join(
        ch.lower() if ch.isalnum() or ch in "._@-" else "-"
        for ch in str(value or "").strip()
    )
    cleaned = cleaned.strip(".-")
    return cleaned[:160] or fallback


def _is_safe_text_file(path: Path) -> bool:
    if path.name.startswith("._") or path.name in IGNORED_METADATA_NAMES:
        return False
    if path.name == "SKILL.md":
        return True
    return path.suffix.lower() in SAFE_TEXT_SUFFIXES


def _is_unsafe_path(path: Path) -> bool:
    return any(part in FORBIDDEN_DIRS or part == ".." or part.startswith(".") for part in path.parts)

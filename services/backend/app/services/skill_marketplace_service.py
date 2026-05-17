"""Static Skill marketplace sync and installation.

The marketplace is served as GitHub Pages/static files. Runtime Agent
execution never reads from the marketplace; installed Skills are copied into
the local `skills` table first.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import urllib.parse
import urllib.request
from urllib.error import HTTPError

from sqlalchemy.orm import Session

from ..models import Skill
from ..settings import settings
from .skill_content_crypto import encrypt_skill_content


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
        entries = [self._entry_from_raw(raw) for raw in payload.get("skills", [])]
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
        content = self._fetch_text(entry.entry_url)
        checksum = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if entry.checksum_sha256 and checksum != entry.checksum_sha256:
            raise SkillMarketplaceError("Skill checksum mismatch")

        now = datetime.utcnow()
        existing = self._installed_by_catalog_id(user_id=user_id).get(entry.id)
        meta_tags = _catalog_tags(entry, checksum=checksum)
        if existing is None:
            row = Skill(
                owner_user_id=user_id,
                name=entry.name,
                public_name=entry.id,
                description=entry.description,
                content=encrypt_skill_content(content),
                visibility="private",
                source="marketplace",
                version=1,
                tags=meta_tags,
                created_at=now,
                updated_at=now,
            )
            self.db.add(row)
        else:
            row = existing
            row.name = entry.name
            row.public_name = entry.id
            row.description = entry.description
            row.content = encrypt_skill_content(content)
            row.visibility = "private"
            row.source = "marketplace"
            row.tags = meta_tags
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

    def _find_entry(self, skill_id: str, *, user_id: str) -> MarketplaceEntry:
        for entry in self.list_entries(user_id=user_id):
            if entry.id == skill_id:
                return entry
        raise SkillMarketplaceError("Skill not found in marketplace")

    def _fetch_catalog(self) -> dict:
        if not self.catalog_url:
            raise SkillMarketplaceError("Skill marketplace URL is not configured")
        return json.loads(self._fetch_text(self.catalog_url))

    def _fetch_text(self, url_or_path: str) -> str:
        url = urllib.parse.urljoin(self.catalog_url, url_or_path)
        req = urllib.request.Request(
            url,
            headers={"Accept": "application/json,text/plain,*/*", "User-Agent": "YuwanLabWriter"},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read()
        except HTTPError as exc:
            raise SkillMarketplaceError(f"Skill marketplace request failed: HTTP {exc.code}") from exc
        except Exception as exc:  # pragma: no cover - runtime/network path
            raise SkillMarketplaceError(f"Skill marketplace request failed: {exc}") from exc
        return raw.decode("utf-8")

    def _entry_from_raw(self, raw: dict) -> MarketplaceEntry:
        path = str(raw.get("path") or "").strip()
        entry = str(raw.get("entry") or "SKILL.md").strip()
        skill_url = str(raw.get("skill_url") or f"{path}/skill.yaml").strip()
        entry_url = str(raw.get("entry_url") or f"{path}/{entry}").strip()
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


def _catalog_tags(entry: MarketplaceEntry, *, checksum: str) -> list[str]:
    tags = [tag for tag in entry.tags if not tag.startswith("ylw:")]
    tags.extend(
        [
            f"ylw:catalog-id={entry.id}",
            f"ylw:catalog-version={entry.version}",
            f"ylw:catalog-author={entry.author_github}",
            f"ylw:catalog-checksum={checksum}",
        ]
    )
    return tags


def _catalog_meta(row: Skill) -> dict[str, str]:
    out: dict[str, str] = {}
    for tag in row.tags or []:
        text = str(tag)
        if text.startswith("ylw:catalog-id="):
            out["id"] = text.split("=", 1)[1]
        elif text.startswith("ylw:catalog-version="):
            out["version"] = text.split("=", 1)[1]
        elif text.startswith("ylw:catalog-author="):
            out["author"] = text.split("=", 1)[1]
        elif text.startswith("ylw:catalog-checksum="):
            out["checksum"] = text.split("=", 1)[1]
    return out


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

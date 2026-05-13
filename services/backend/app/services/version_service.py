"""Document version snapshots (V3 Phase 3).

Storage model is borrowed from Overleaf history-v1 (see reference/overleaf/):
content lives in `blobs` (SHA1-keyed, deduped across docs), per-doc snapshots
live in `document_versions` (monotonic `version` int), and user-named pins
live in `document_labels` (labels exempt their version from LRU eviction).

Snapshot policy:
  * 10-minute cooldown for consecutive `auto_save` snapshots of identical
    content (cheap no-op so the autosave path can call snapshot() blindly).
  * Per-doc cap of 100 versions; on overflow, evict the oldest *unlabeled*
    version. Labeled versions are protected. Orphan blobs are not GC'd in V3.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta

from sqlalchemy import desc
from sqlalchemy.orm import Session

from ..models import Blob, DocumentLabel, DocumentVersion


COOLDOWN = timedelta(minutes=10)
VERSION_CAP = 100

ALLOWED_ORIGINS = {"auto_save", "accept_suggestion", "manual", "restore", "ai_edit"}


def _sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


def _upsert_blob(db: Session, content_bytes: bytes) -> Blob:
    h = _sha1(content_bytes)
    existing = db.get(Blob, h)
    if existing is not None:
        return existing
    string_length: int | None
    # Treat any NUL byte as a binary signal even if the bytes happen to be
    # valid UTF-8. Matches the textiness check Overleaf and most editors use.
    if b"\x00" in content_bytes:
        string_length = None
    else:
        try:
            string_length = len(content_bytes.decode("utf-8"))
        except UnicodeDecodeError:
            string_length = None
    blob = Blob(
        hash=h,
        content=content_bytes,
        byte_length=len(content_bytes),
        string_length=string_length,
    )
    db.add(blob)
    db.flush()
    return blob


def snapshot(
    db: Session,
    doc_id: str,
    content_bytes: bytes,
    origin: str = "auto_save",
    actor: str | None = None,
) -> DocumentVersion | None:
    """Record a new version of `doc_id`. Returns the new row, or None if the
    write was elided by the cooldown rule.
    """
    if origin not in ALLOWED_ORIGINS:
        raise ValueError(f"invalid origin: {origin!r}")

    blob = _upsert_blob(db, content_bytes)

    latest = (
        db.query(DocumentVersion)
        .filter(DocumentVersion.doc_id == doc_id)
        .order_by(desc(DocumentVersion.version))
        .first()
    )

    if (
        latest is not None
        and origin == "auto_save"
        and latest.origin == "auto_save"
        and latest.blob_hash == blob.hash
        and datetime.utcnow() - latest.created_at < COOLDOWN
    ):
        return None

    next_version = (latest.version + 1) if latest else 1
    row = DocumentVersion(
        doc_id=doc_id,
        version=next_version,
        blob_hash=blob.hash,
        origin=origin,
        actor=actor,
    )
    db.add(row)
    db.flush()

    _prune_lru(db, doc_id)
    db.commit()
    db.refresh(row)
    return row


def _prune_lru(db: Session, doc_id: str) -> None:
    """Trim versions for `doc_id` down to VERSION_CAP, skipping labeled ones."""
    total = (
        db.query(DocumentVersion)
        .filter(DocumentVersion.doc_id == doc_id)
        .count()
    )
    if total <= VERSION_CAP:
        return

    labeled = {
        v
        for (v,) in db.query(DocumentLabel.version)
        .filter(DocumentLabel.doc_id == doc_id)
        .all()
    }

    candidates = (
        db.query(DocumentVersion)
        .filter(DocumentVersion.doc_id == doc_id)
        .order_by(DocumentVersion.version.asc())
        .all()
    )

    to_delete = total - VERSION_CAP
    for v in candidates:
        if to_delete <= 0:
            break
        if v.version in labeled:
            continue
        db.delete(v)
        to_delete -= 1


def list_versions(db: Session, doc_id: str) -> list[DocumentVersion]:
    return (
        db.query(DocumentVersion)
        .filter(DocumentVersion.doc_id == doc_id)
        .order_by(desc(DocumentVersion.version))
        .all()
    )


def get_version(db: Session, doc_id: str, version: int) -> DocumentVersion | None:
    return (
        db.query(DocumentVersion)
        .filter(DocumentVersion.doc_id == doc_id, DocumentVersion.version == version)
        .first()
    )


def list_labels(db: Session, doc_id: str) -> list[DocumentLabel]:
    return (
        db.query(DocumentLabel)
        .filter(DocumentLabel.doc_id == doc_id)
        .order_by(desc(DocumentLabel.created_at))
        .all()
    )


def add_label(db: Session, doc_id: str, version: int, text: str) -> DocumentLabel:
    if get_version(db, doc_id, version) is None:
        raise ValueError("version not found")
    label = DocumentLabel(doc_id=doc_id, version=version, text=text)
    db.add(label)
    db.commit()
    db.refresh(label)
    return label


def remove_label(db: Session, doc_id: str, label_id: str) -> bool:
    label = db.get(DocumentLabel, label_id)
    if label is None or label.doc_id != doc_id:
        return False
    db.delete(label)
    db.commit()
    return True

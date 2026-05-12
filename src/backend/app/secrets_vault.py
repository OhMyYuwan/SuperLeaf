"""Local Fernet key management for provider API-key encryption.

The key lives on disk under ~/.yuwanlab/secrets.key (mode 600). It's generated
on first run. Rotating the key requires re-entering all provider API keys,
which is intentional — we never want plaintext keys in the DB.
"""

from __future__ import annotations

import os

from cryptography.fernet import Fernet

from .settings import settings


def _load_or_create_key() -> bytes:
    path = settings.resolved_secrets_key_path()
    if path.exists():
        return path.read_bytes()
    key = Fernet.generate_key()
    path.write_bytes(key)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_key())
    return _fernet


def encrypt(plain: str) -> str:
    if not plain:
        return ""
    return _get_fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt(cipher: str) -> str:
    if not cipher:
        return ""
    return _get_fernet().decrypt(cipher.encode("ascii")).decode("utf-8")

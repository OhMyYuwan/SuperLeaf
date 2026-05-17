"""Encryption helpers for Skill instruction content.

Skill content is not as sensitive as provider API keys, but it can contain
private prompts, evaluation policy, or unpublished workflow know-how. Store it
encrypted at rest and decrypt only at API/runtime boundaries.
"""

from __future__ import annotations

from cryptography.fernet import InvalidToken

from ..secrets_vault import decrypt, encrypt


_PREFIX = "fernet:"


def encrypt_skill_content(content: str) -> str:
    if not content:
        return ""
    if content.startswith(_PREFIX):
        return content
    return f"{_PREFIX}{encrypt(content)}"


def decrypt_skill_content(value: str) -> str:
    if not value:
        return ""
    if not value.startswith(_PREFIX):
        return value
    cipher = value[len(_PREFIX) :]
    try:
        return decrypt(cipher)
    except (InvalidToken, ValueError):
        return ""


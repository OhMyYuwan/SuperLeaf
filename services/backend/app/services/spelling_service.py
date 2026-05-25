"""Local spell checking and user dictionary service.

The editor-facing behavior mirrors the durable parts of Overleaf's spellcheck
pipeline: a deterministic dictionary engine, per-user learned words, and cheap
suggestion lookup. The backend engine is intentionally isolated so it can be
replaced by Hunspell or LanguageTool without changing the HTTP contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from spellchecker import SpellChecker

from ..models import SpellingPreference


MAX_CHECK_WORDS = 500
MAX_WORD_LENGTH = 64
MAX_SUGGESTIONS = 6

_LANGUAGE_ALIASES = {
    "en": "en",
    "en-us": "en",
    "en_us": "en",
    "en-gb": "en",
    "en_gb": "en",
}

_TECHNICAL_WORDS = {
    "ai",
    "api",
    "arxiv",
    "backend",
    "biblatex",
    "bibtex",
    "codemirror",
    "crdt",
    "csv",
    "doi",
    "fastapi",
    "frontend",
    "github",
    "json",
    "latex",
    "llm",
    "markdown",
    "mcp",
    "nanobot",
    "overleaf",
    "pdf",
    "rag",
    "ragas",
    "sqlite",
    "superleaf",
    "tex",
    "tsx",
    "typescript",
    "yaml",
    "yjs",
}


@dataclass(frozen=True)
class Misspelling:
    word: str
    suggestions: list[str]


class SpellingService:
    def __init__(self, db: Session):
        self.db = db

    def check_words(
        self,
        user_id: str,
        language: str,
        words: Iterable[str],
    ) -> list[Misspelling]:
        lang = normalize_language(language)
        engine = _engine_for(lang)
        learned = self.learned_words(user_id, lang)
        unique_words = normalize_word_batch(words)
        unknown = engine.unknown(unique_words)
        unknown_keys = {w.casefold() for w in unknown}

        out: list[Misspelling] = []
        for word in unique_words:
            key = word.casefold()
            if key in learned:
                continue
            if key not in unknown_keys:
                continue
            out.append(Misspelling(word=word, suggestions=self.suggestions(lang, word)))
        return out

    def suggestions(self, language: str, word: str) -> list[str]:
        lang = normalize_language(language)
        clean = normalize_word(word)
        if not clean:
            return []
        engine = _engine_for(lang)
        candidates = engine.candidates(clean) or set()
        candidates = {
            c
            for c in candidates
            if c and c.casefold() != clean.casefold() and is_spellcheckable_word(c)
        }
        correction = engine.correction(clean)
        ranked = sorted(
            candidates,
            key=lambda item: (
                0 if correction and item.casefold() == correction.casefold() else 1,
                -SequenceMatcher(None, clean.casefold(), item.casefold()).ratio(),
                len(item),
                item.casefold(),
            ),
        )
        return ranked[:MAX_SUGGESTIONS]

    def learned_words(self, user_id: str, language: str) -> set[str]:
        pref = self._get_preference(user_id, normalize_language(language), create=False)
        if pref is None:
            return set()
        return {normalize_word(w).casefold() for w in pref.words if normalize_word(w)}

    def learned_words_list(self, user_id: str, language: str) -> list[str]:
        pref = self._get_preference(user_id, normalize_language(language), create=False)
        if pref is None:
            return []
        return sorted({normalize_word(w) for w in pref.words if normalize_word(w)}, key=str.casefold)

    def learn_word(self, user_id: str, language: str, word: str) -> list[str]:
        lang = normalize_language(language)
        clean = normalize_word(word)
        if not clean or not is_spellcheckable_word(clean):
            return self.learned_words_list(user_id, lang)
        pref = self._get_preference(user_id, lang, create=True)
        assert pref is not None
        existing = {normalize_word(w).casefold(): normalize_word(w) for w in pref.words if normalize_word(w)}
        existing[clean.casefold()] = clean
        pref.words = sorted(existing.values(), key=str.casefold)
        self.db.add(pref)
        self.db.commit()
        return list(pref.words)

    def unlearn_word(self, user_id: str, language: str, word: str) -> list[str]:
        lang = normalize_language(language)
        clean = normalize_word(word)
        pref = self._get_preference(user_id, lang, create=False)
        if pref is None or not clean:
            return []
        pref.words = [
            normalize_word(w)
            for w in pref.words
            if normalize_word(w) and normalize_word(w).casefold() != clean.casefold()
        ]
        self.db.add(pref)
        self.db.commit()
        return self.learned_words_list(user_id, lang)

    def _get_preference(
        self,
        user_id: str,
        language: str,
        *,
        create: bool,
    ) -> SpellingPreference | None:
        stmt = select(SpellingPreference).where(
            SpellingPreference.user_id == user_id,
            SpellingPreference.language == language,
        )
        pref = self.db.scalars(stmt).first()
        if pref is None and create:
            pref = SpellingPreference(user_id=user_id, language=language, words=[])
            self.db.add(pref)
            self.db.flush()
        return pref


def normalize_language(language: str) -> str:
    key = (language or "en").strip().casefold()
    return _LANGUAGE_ALIASES.get(key, "en")


def normalize_word(word: str) -> str:
    return (word or "").strip().strip(".,;:!?()[]{}<>\"“”‘’")


def normalize_word_batch(words: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in words:
        word = normalize_word(raw)
        key = word.casefold()
        if key in seen:
            continue
        if not is_spellcheckable_word(word):
            continue
        seen.add(key)
        out.append(word)
        if len(out) >= MAX_CHECK_WORDS:
            break
    return out


def is_spellcheckable_word(word: str) -> bool:
    if len(word) < 2 or len(word) > MAX_WORD_LENGTH:
        return False
    if any(ch.isdigit() for ch in word):
        return False
    if "_" in word or "\\" in word or "/" in word:
        return False
    if word.isupper() and len(word) > 1:
        return False
    return any(ch.isalpha() for ch in word)


@lru_cache(maxsize=8)
def _engine_for(language: str) -> SpellChecker:
    engine = SpellChecker(language=language)
    engine.word_frequency.load_words(_TECHNICAL_WORDS)
    return engine

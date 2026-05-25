"""Spelling API routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import User
from ..services.spelling_service import SpellingService
from .deps import get_current_user

router = APIRouter(prefix="/api/spelling", tags=["spelling"])


class SpellingCheckIn(BaseModel):
    language: str = Field(default="en", max_length=32)
    words: list[str] = Field(default_factory=list, max_length=500)


class SpellingWordIn(BaseModel):
    language: str = Field(default="en", max_length=32)
    word: str = Field(min_length=1, max_length=64)


class SpellingMisspellingOut(BaseModel):
    word: str
    suggestions: list[str]


class SpellingCheckOut(BaseModel):
    language: str
    misspellings: list[SpellingMisspellingOut]


class SpellingDictionaryOut(BaseModel):
    language: str
    words: list[str]


@router.post("/check", response_model=SpellingCheckOut)
def check_spelling(
    body: SpellingCheckIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> SpellingCheckOut:
    service = SpellingService(db)
    language = body.language or "en"
    misspellings = service.check_words(user.id, language, body.words)
    return SpellingCheckOut(
        language=language,
        misspellings=[
            SpellingMisspellingOut(word=item.word, suggestions=item.suggestions)
            for item in misspellings
        ],
    )


@router.post("/suggest", response_model=SpellingMisspellingOut)
def suggest_spelling(
    body: SpellingWordIn,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> SpellingMisspellingOut:
    return SpellingMisspellingOut(
        word=body.word,
        suggestions=SpellingService(db).suggestions(body.language, body.word),
    )


@router.get("/dictionary", response_model=SpellingDictionaryOut)
def spelling_dictionary(
    language: str = "en",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> SpellingDictionaryOut:
    return SpellingDictionaryOut(
        language=language,
        words=SpellingService(db).learned_words_list(user.id, language),
    )


@router.post("/learn", response_model=SpellingDictionaryOut)
def learn_spelling_word(
    body: SpellingWordIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> SpellingDictionaryOut:
    return SpellingDictionaryOut(
        language=body.language,
        words=SpellingService(db).learn_word(user.id, body.language, body.word),
    )


@router.post("/unlearn", response_model=SpellingDictionaryOut)
def unlearn_spelling_word(
    body: SpellingWordIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> SpellingDictionaryOut:
    return SpellingDictionaryOut(
        language=body.language,
        words=SpellingService(db).unlearn_word(user.id, body.language, body.word),
    )

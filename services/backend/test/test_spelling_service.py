from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.services.spelling_service import SpellingService


def test_learned_word_is_ignored_by_later_checks():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    db = session_factory()
    service = SpellingService(db)

    user_id = "user-1"
    word = "ImageNettt"

    assert [item.word for item in service.check_words(user_id, "en", [word])] == [word]
    assert service.learn_word(user_id, "en", word) == [word]
    assert service.learned_words_list(user_id, "en") == [word]
    assert service.check_words(user_id, "en", [word]) == []

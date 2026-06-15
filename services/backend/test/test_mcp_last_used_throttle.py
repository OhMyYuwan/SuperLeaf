"""Test last_used_at throttling to reduce SQLite write contention."""

from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import McpToken, User
from app.services.mcp_token_service import McpTokenService, _LAST_USED_THROTTLE_SECONDS


@pytest.fixture()
def db() -> Session:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture()
def user(db: Session) -> User:
    u = User(id="user1", email="user@example.com", password_hash="hash", display_name="User")
    db.add(u)
    db.commit()
    return u


def test_last_used_at_throttling(db: Session, user: User):
    """verify_token should only update last_used_at every 60 seconds, not every call."""
    svc = McpTokenService(db)
    row, token = svc.create_token(user_id=user.id, name="test", scope="read", expires_in_days=1)

    # First call: last_used_at is None, should update
    result = svc.verify_token(token, ip="1.2.3.4")
    assert result is not None
    user_out, token_row = result
    assert token_row.last_used_at is not None
    first_used_at = token_row.last_used_at
    assert token_row.last_used_ip == "1.2.3.4"

    # Refresh to clear session cache
    db.refresh(token_row)

    # Second call immediately after (< 60s): should NOT update
    result2 = svc.verify_token(token, ip="5.6.7.8")
    assert result2 is not None
    _, token_row2 = result2
    db.refresh(token_row2)
    assert token_row2.last_used_at == first_used_at, "Should not update within throttle window"
    assert token_row2.last_used_ip == "1.2.3.4", "IP should not change within throttle window"

    # Simulate time passing beyond throttle window
    fake_old_time = datetime.utcnow() - timedelta(seconds=_LAST_USED_THROTTLE_SECONDS + 1)
    token_row2.last_used_at = fake_old_time
    db.commit()
    db.refresh(token_row2)

    # Third call after throttle window: should update
    result3 = svc.verify_token(token, ip="9.10.11.12")
    assert result3 is not None
    _, token_row3 = result3
    db.refresh(token_row3)
    assert token_row3.last_used_at > fake_old_time, "Should update after throttle window expires"
    assert token_row3.last_used_ip == "9.10.11.12", "IP should update after throttle window"


def test_first_use_always_updates(db: Session, user: User):
    """First verify_token call should always update last_used_at, even if None."""
    svc = McpTokenService(db)
    row, token = svc.create_token(user_id=user.id, name="test", scope="read", expires_in_days=1)

    # Token just created, last_used_at is None
    assert row.last_used_at is None

    # First verify should set it
    result = svc.verify_token(token, ip="1.2.3.4")
    assert result is not None
    _, token_row = result
    db.refresh(token_row)
    assert token_row.last_used_at is not None
    assert token_row.last_used_ip == "1.2.3.4"

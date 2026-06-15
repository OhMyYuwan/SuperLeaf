from __future__ import annotations

import socket
from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import User
from app.services.provider_service import ProviderService


@pytest.fixture()
def db() -> Iterator[Session]:
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
        session.add(User(id="user-a", email="user@example.com", password_hash="hash"))
        session.commit()
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://127.0.0.1:11434",
        "http://[::1]:11434",
        "http://10.1.2.3:8000",
        "http://169.254.169.254/latest/meta-data",
        "http://localhost:8000",
        "http://service.localhost:8000",
    ],
)
def test_backend_provider_create_rejects_private_network_endpoints(
    db: Session, endpoint: str
) -> None:
    with pytest.raises(ValueError, match="private|localhost|reserved"):
        ProviderService(db).create(
            user_id="user-a",
            name="unsafe",
            kind="nanobot",
            endpoint=endpoint,
            api_key="secret",
        )


def test_backend_provider_create_rejects_dns_name_resolving_to_private_ip(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.7", 443)),
        ],
    )

    with pytest.raises(ValueError, match="private|reserved"):
        ProviderService(db).create(
            user_id="user-a",
            name="unsafe",
            kind="dify-cloud",
            endpoint="https://provider.example.test/v1",
            api_key="secret",
        )


def test_backend_provider_create_fails_closed_on_dns_resolution_failure(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A hostname that does not resolve at registration time must be rejected,
    # not silently accepted: the legacy gaierror->return path was an SSRF
    # fail-open (the name could still resolve to an internal address later).
    def boom(*_args, **_kwargs):
        raise socket.gaierror("no such host")

    monkeypatch.setattr(socket, "getaddrinfo", boom)

    with pytest.raises(ValueError, match="resolve|refus"):
        ProviderService(db).create(
            user_id="user-a",
            name="unresolvable",
            kind="dify-cloud",
            endpoint="https://nxdomain.attacker.test/v1",
            api_key="secret",
        )


def test_backend_provider_create_allows_public_https_endpoint(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
        ],
    )

    provider = ProviderService(db).create(
        user_id="user-a",
        name="public",
        kind="dify-cloud",
        endpoint="https://provider.example.test/v1/",
        api_key="secret",
    )

    assert provider.endpoint == "https://provider.example.test/v1"


def test_browser_nanobot_provider_allows_local_browser_endpoint(db: Session) -> None:
    provider = ProviderService(db).create(
        user_id="user-a",
        name="browser nanobot",
        kind="nanobot",
        endpoint="http://127.0.0.1:11434",
        api_key="secret",
        transport="browser",
    )

    assert provider.endpoint == "http://127.0.0.1:11434"
    assert provider.meta["transport"] == "browser"

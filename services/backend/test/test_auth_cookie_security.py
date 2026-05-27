from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.auth import router as auth_router
from app.database import Base
from app.database import get_session as get_db_session
from app.services.auth_service import AuthService
from app.settings import settings


def _db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        future=True,
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return session_factory()


def _client(db, *, base_url: str = "http://testserver") -> TestClient:
    app = FastAPI()

    def override_session():
        yield db

    app.dependency_overrides[get_db_session] = override_session
    app.include_router(auth_router)
    return TestClient(app, base_url=base_url)


def _login(client: TestClient) -> str:
    response = client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "Password1"},
    )
    assert response.status_code == 200
    return response.headers["set-cookie"]


def _seed_user(db) -> None:
    AuthService(db).register("admin@example.com", "Password1", bootstrap_token="bootstrap-secret")


def test_cookie_auto_mode_allows_local_http(monkeypatch):
    monkeypatch.setattr(settings, "public_registration", False)
    monkeypatch.setattr(settings, "bootstrap_token", "bootstrap-secret")
    monkeypatch.setattr(settings, "cookie_secure", "auto")
    db = _db()
    _seed_user(db)

    set_cookie = _login(_client(db))

    assert "httponly" in set_cookie.lower()
    assert "secure" not in set_cookie.lower()


def test_cookie_auto_mode_uses_forwarded_https(monkeypatch):
    monkeypatch.setattr(settings, "public_registration", False)
    monkeypatch.setattr(settings, "bootstrap_token", "bootstrap-secret")
    monkeypatch.setattr(settings, "cookie_secure", "auto")
    db = _db()
    _seed_user(db)
    client = _client(db)

    response = client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "Password1"},
        headers={"X-Forwarded-Proto": "https"},
    )

    assert response.status_code == 200
    assert "secure" in response.headers["set-cookie"].lower()


def test_cookie_secure_true_forces_secure_on_http(monkeypatch):
    monkeypatch.setattr(settings, "public_registration", False)
    monkeypatch.setattr(settings, "bootstrap_token", "bootstrap-secret")
    monkeypatch.setattr(settings, "cookie_secure", "true")
    db = _db()
    _seed_user(db)

    set_cookie = _login(_client(db))

    assert "secure" in set_cookie.lower()


def test_cookie_secure_false_allows_https_without_secure_for_local_overrides(monkeypatch):
    monkeypatch.setattr(settings, "public_registration", False)
    monkeypatch.setattr(settings, "bootstrap_token", "bootstrap-secret")
    monkeypatch.setattr(settings, "cookie_secure", "false")
    db = _db()
    _seed_user(db)

    set_cookie = _login(_client(db, base_url="https://testserver"))

    assert "secure" not in set_cookie.lower()

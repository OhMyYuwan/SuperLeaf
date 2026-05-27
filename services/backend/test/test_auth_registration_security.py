import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.auth import router as auth_router
from app.database import Base
from app.database import get_session as get_db_session
from app.models import Project, User
from app.services.auth_service import AuthService, RegistrationClosedError
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


def _client(db):
    app = FastAPI()

    def override_session():
        yield db

    app.dependency_overrides[get_db_session] = override_session
    app.include_router(auth_router)
    return TestClient(app)


@pytest.fixture(autouse=True)
def registration_settings(monkeypatch):
    monkeypatch.setattr(settings, "public_registration", False)
    monkeypatch.setattr(settings, "bootstrap_token", "bootstrap-secret")


def test_first_admin_requires_valid_bootstrap_token():
    db = _db()

    with pytest.raises(RegistrationClosedError):
        AuthService(db).register("admin@example.com", "Password1", bootstrap_token="wrong")

    assert db.query(User).count() == 0


def test_register_endpoint_returns_403_without_bootstrap_token():
    db = _db()
    client = _client(db)

    response = client.post(
        "/api/auth/register",
        json={"email": "admin@example.com", "password": "Password1"},
    )

    assert response.status_code == 403
    assert db.query(User).count() == 0


def test_first_admin_accepts_bootstrap_token_and_backfills_resources():
    db = _db()
    db.add(Project(id="bootstrap-project", user_id="", name="Migrated"))
    db.commit()

    user, sid = AuthService(db).register(
        "admin@example.com",
        "Password1",
        display_name="Admin",
        bootstrap_token="bootstrap-secret",
    )

    project = db.get(Project, "bootstrap-project")
    assert sid
    assert user.is_admin is True
    assert project is not None
    assert project.user_id == user.id


def test_public_registration_disabled_blocks_later_accounts():
    db = _db()
    AuthService(db).register("admin@example.com", "Password1", bootstrap_token="bootstrap-secret")

    with pytest.raises(RegistrationClosedError):
        AuthService(db).register("user@example.com", "Password1")

    assert db.query(User).count() == 1


def test_public_registration_allows_later_non_admin_accounts(monkeypatch):
    db = _db()
    AuthService(db).register("admin@example.com", "Password1", bootstrap_token="bootstrap-secret")
    monkeypatch.setattr(settings, "public_registration", True)

    user, _sid = AuthService(db).register("user@example.com", "Password1")

    assert user.is_admin is False
    assert db.query(User).count() == 2

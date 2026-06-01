from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import SESSION_COOKIE_NAME
from app.api.native_agents import router as native_agents_router
from app.database import Base
from app.database import get_session as get_db_session
from app.models import Session, Skill, User


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
    app.include_router(native_agents_router)
    return TestClient(app)


def _seed_users_and_skills(db):
    expires_at = datetime.utcnow() + timedelta(hours=1)
    owner = User(id="owner", email="owner@example.com", password_hash="hash")
    intruder = User(id="intruder", email="intruder@example.com", password_hash="hash")
    private_skill = Skill(
        id="private-skill",
        owner_user_id=owner.id,
        name="Draft Review Skill",
        public_name="owner@Draft Review Skill",
        description="Private reviewer prompt.",
        content="# Draft Review Skill\n\nReview the manuscript carefully.\n",
        visibility="private",
        source="upload",
        tags=["review", "private"],
    )
    public_skill = Skill(
        id="public-skill",
        owner_user_id=owner.id,
        name="Published Skill",
        public_name="owner@Published Skill",
        description="Published prompt.",
        content="# Published Skill\n",
        visibility="public",
        source="upload",
    )
    custom_skill = Skill(
        id="custom-skill",
        owner_user_id=owner.id,
        name="Recipe Skill",
        public_name="owner@recipe",
        description="External recipe.",
        content="",
        visibility="private",
        source="custom",
    )
    db.add_all(
        [
            owner,
            intruder,
            Session(id="owner-session", user_id=owner.id, expires_at=expires_at),
            Session(id="intruder-session", user_id=intruder.id, expires_at=expires_at),
            private_skill,
            public_skill,
            custom_skill,
        ]
    )
    db.commit()


def _zip_entries(payload: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        return {name: zf.read(name) for name in zf.namelist()}


def test_private_uploaded_skill_downloads_as_zip():
    db = _db()
    _seed_users_and_skills(db)
    client = _client(db)

    response = client.get(
        "/api/native-agent/skills/private-skill/download",
        cookies={SESSION_COOKIE_NAME: "owner-session"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/zip")
    assert (
        "filename*=UTF-8''Draft%20Review%20Skill.zip"
        in response.headers["content-disposition"]
    )
    entries = _zip_entries(response.content)
    assert (
        entries["Draft Review Skill/SKILL.md"].decode()
        == "# Draft Review Skill\n\nReview the manuscript carefully.\n"
    )
    manifest = json.loads(entries["Draft Review Skill/manifest.json"].decode())
    assert manifest["kind"] == "superleaf.skill.export"
    assert manifest["entry"] == "SKILL.md"
    assert manifest["name"] == "Draft Review Skill"
    assert manifest["public_name"] == "owner@Draft Review Skill"
    assert manifest["tags"] == ["review", "private"]


def test_public_skill_owned_by_another_user_can_be_downloaded_when_visible():
    db = _db()
    _seed_users_and_skills(db)
    client = _client(db)

    response = client.get(
        "/api/native-agent/skills/public-skill/download",
        cookies={SESSION_COOKIE_NAME: "intruder-session"},
    )

    assert response.status_code == 200
    entries = _zip_entries(response.content)
    assert entries["Published Skill/SKILL.md"].decode() == "# Published Skill\n"


def test_private_skill_owned_by_another_user_is_not_visible_for_download():
    db = _db()
    _seed_users_and_skills(db)
    client = _client(db)

    response = client.get(
        "/api/native-agent/skills/private-skill/download",
        cookies={SESSION_COOKIE_NAME: "intruder-session"},
    )

    assert response.status_code == 404


def test_recipe_skill_can_be_downloaded_when_visible():
    db = _db()
    _seed_users_and_skills(db)
    client = _client(db)

    response = client.get(
        "/api/native-agent/skills/custom-skill/download",
        cookies={SESSION_COOKIE_NAME: "owner-session"},
    )

    assert response.status_code == 200
    entries = _zip_entries(response.content)
    assert entries["Recipe Skill/SKILL.md"].decode() == ""
    manifest = json.loads(entries["Recipe Skill/manifest.json"].decode())
    assert manifest["source"] == "custom"

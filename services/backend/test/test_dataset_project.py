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

from app.api.datasets import router as datasets_router
from app.api.deps import SESSION_COOKIE_NAME
from app.database import Base
from app.database import get_session as get_db_session
from app.models import Annotation, DatasetRecord, Doc, NativeAgent, Project, Session, User, WorkflowRun


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
    app.include_router(datasets_router)
    return TestClient(app)


def _zip_entries(payload: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        return {name: zf.read(name) for name in zf.namelist()}


def test_data_project_sync_label_and_export_zip():
    db = _db()
    client = _client(db)
    now = datetime.utcnow()
    owner = User(id="owner", email="owner@example.com", password_hash="hash")
    source_project = Project(id="source", user_id=owner.id, name="Source Paper", project_type="paper")
    data_project = Project(id="dataset", user_id=owner.id, name="质量数据集", project_type="data")
    doc = Doc(id="doc1", project_id=source_project.id, folder_id=None, name="main.md", content="Draft text")
    agent = NativeAgent(
        id="agent1",
        project_id=source_project.id,
        owner_user_id=owner.id,
        provider_id="",
        name="Reviewer",
        skill_ids=["skill1"],
    )
    annotation = Annotation(
        id="ann1",
        doc_id=doc.id,
        project_id=source_project.id,
        user_id=owner.id,
        is_global=False,
        kind="suggestion",
        status="pending",
        range_from=0,
        range_to=10,
        target_text="Draft text",
        content="Needs stronger claim support.",
        severity="medium",
        workflow_id="native:agent1",
        agent_name="Reviewer",
        proposed="Add evidence before the claim.",
        reason="Unsupported claim.",
        thread=[
            {"id": "m1", "role": "user", "content": "Review this", "created_at": now.isoformat()},
            {"id": "m2", "role": "agent", "content": "Add evidence.", "created_at": now.isoformat()},
        ],
        created_at=now,
    )
    db.add_all(
        [
            owner,
            source_project,
            data_project,
            doc,
            agent,
            annotation,
            Session(id="owner-session", user_id=owner.id, expires_at=now + timedelta(hours=1)),
        ]
    )
    db.commit()

    headers = {"X-Project-Id": data_project.id}
    cookies = {SESSION_COOKIE_NAME: "owner-session"}

    current = client.get("/api/datasets/current", headers=headers, cookies=cookies)
    assert current.status_code == 200
    assert current.json()["project_id"] == data_project.id

    created_rule = client.post(
        "/api/datasets/current/source-rules",
        headers=headers,
        cookies=cookies,
        json={
            "source_project_id": source_project.id,
            "source_types": ["annotations"],
            "filters": {"skill_id": "skill1"},
        },
    )
    assert created_rule.status_code == 201
    rule_id = created_rule.json()["id"]

    first_sync = client.post(
        f"/api/datasets/source-rules/{rule_id}/sync",
        headers=headers,
        cookies=cookies,
    )
    assert first_sync.status_code == 200
    assert first_sync.json()["created"] == 1
    assert first_sync.json()["skipped"] == 0

    second_sync = client.post(
        f"/api/datasets/source-rules/{rule_id}/sync",
        headers=headers,
        cookies=cookies,
    )
    assert second_sync.status_code == 200
    assert second_sync.json()["created"] == 0
    assert second_sync.json()["skipped"] == 1

    listed = client.get("/api/datasets/current/records", headers=headers, cookies=cookies)
    assert listed.status_code == 200
    payload = listed.json()
    assert payload["total"] == 1
    record = payload["records"][0]
    assert record["fields"]["source_text"] == "Draft text"
    assert record["fields"]["agent_output"] == "Add evidence before the claim."
    assert record["provenance"]["skill_ids"] == ["skill1"]

    submitted = client.post(
        f"/api/datasets/records/{record['id']}/response/me/submit",
        headers=headers,
        cookies=cookies,
        json={
            "values": {
                "task_success": "partial",
                "helpfulness": 4,
                "issues": ["missing_context"],
                "comments": "Good catch, needs evidence.",
                "training_candidate": "yes",
            },
            "lead_time_ms": 1200,
        },
    )
    assert submitted.status_code == 200
    assert submitted.json()["status"] == "submitted"

    exported = client.get(
        "/api/datasets/current/export.zip?status=submitted",
        headers=headers,
        cookies=cookies,
    )
    assert exported.status_code == 200
    assert "filename*=UTF-8''" in exported.headers["content-disposition"]
    entries = _zip_entries(exported.content)
    manifest = json.loads(entries["manifest.json"].decode())
    assert manifest["record_count"] == 1
    sample = json.loads(entries["labeled_samples.jsonl"].decode().strip())
    assert sample["response"]["values"]["task_success"] == "partial"
    assert sample["metadata"]["doc_name"] == "main.md"


def test_data_project_workflow_run_source_text_is_snapshot():
    db = _db()
    client = _client(db)
    now = datetime.utcnow()
    owner = User(id="owner", email="owner@example.com", password_hash="hash")
    source_project = Project(id="source", user_id=owner.id, name="Source Paper", project_type="paper")
    data_project = Project(id="dataset", user_id=owner.id, name="Workflow Dataset", project_type="data")
    doc = Doc(
        id="doc1",
        project_id=source_project.id,
        folder_id=None,
        name="main.md",
        content="The live document may change after this run.",
    )
    run = WorkflowRun(
        id="run1",
        project_id=source_project.id,
        user_id=owner.id,
        provider_id="",
        workflow_id="",
        document_id=doc.id,
        range_start=4,
        range_end=17,
        source_text="selected snapshot",
        status="completed",
        outputs={"text": "Agent evaluated the selected snapshot."},
        trace=[{"request": {"inputs": {"target_text": "selected snapshot"}}}],
        started_at=now,
        finished_at=now,
    )
    db.add_all(
        [
            owner,
            source_project,
            data_project,
            doc,
            run,
            Session(id="owner-session", user_id=owner.id, expires_at=now + timedelta(hours=1)),
        ]
    )
    db.commit()

    headers = {"X-Project-Id": data_project.id}
    cookies = {SESSION_COOKIE_NAME: "owner-session"}
    current = client.get("/api/datasets/current", headers=headers, cookies=cookies)
    assert current.status_code == 200

    created_rule = client.post(
        "/api/datasets/current/source-rules",
        headers=headers,
        cookies=cookies,
        json={
            "source_project_id": source_project.id,
            "source_types": ["workflow_runs"],
            "filters": {},
        },
    )
    assert created_rule.status_code == 201
    rule_id = created_rule.json()["id"]

    first_sync = client.post(
        f"/api/datasets/source-rules/{rule_id}/sync",
        headers=headers,
        cookies=cookies,
    )
    assert first_sync.status_code == 200
    assert first_sync.json()["created"] == 1

    listed = client.get("/api/datasets/current/records", headers=headers, cookies=cookies)
    assert listed.status_code == 200
    record = listed.json()["records"][0]
    assert record["fields"]["source_text"] == "selected snapshot"
    assert record["record_metadata"]["range"] == {"from": 4, "to": 17}

    stored = db.get(DatasetRecord, record["id"])
    assert stored is not None
    stored.fields = {
        **stored.fields,
        "source_text": json.dumps(
            {"document_id": doc.id, "range_start": run.range_start, "range_end": run.range_end}
        ),
    }
    db.commit()

    second_sync = client.post(
        f"/api/datasets/source-rules/{rule_id}/sync",
        headers=headers,
        cookies=cookies,
    )
    assert second_sync.status_code == 200
    assert second_sync.json()["created"] == 0
    assert second_sync.json()["skipped"] == 1

    repaired = client.get("/api/datasets/current/records", headers=headers, cookies=cookies)
    assert repaired.status_code == 200
    assert repaired.json()["records"][0]["fields"]["source_text"] == "selected snapshot"

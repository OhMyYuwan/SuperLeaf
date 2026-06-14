from __future__ import annotations

import json
from datetime import datetime

import pytest
from fastapi import HTTPException

from app.api import collab_consistency
from app.api import filesystem as filesystem_api
from app.models import Doc, Project
from app.schemas import DocUpdateIn
from app.services.collab_audit_log import record_collab_event
from app.services.collab_snapshot_service import CollabSnapshotError
from app.services.project_fs_service import DocVersionConflictError


def test_collab_audit_log_writes_main_and_error_files(tmp_path) -> None:
    record_collab_event(
        "doc_version_conflict",
        level="warning",
        project_id="project-1",
        doc_id="doc-1",
        operation="save",
        code="doc_version_conflict",
        message="version mismatch",
        details={"expected_version": 1, "current_version": 2},
        log_dir=tmp_path,
    )

    main_payload = json.loads((tmp_path / "collaboration.log").read_text().strip())
    error_payload = json.loads((tmp_path / "collaboration-errors.log").read_text().strip())

    assert main_payload["event"] == "doc_version_conflict"
    assert main_payload["level"] == "warning"
    assert main_payload["project_id"] == "project-1"
    assert main_payload["doc_id"] == "doc-1"
    assert main_payload["operation"] == "save"
    assert main_payload["code"] == "doc_version_conflict"
    assert main_payload["details"] == {"expected_version": 1, "current_version": 2}
    assert error_payload == main_payload


def test_collab_audit_log_keeps_info_events_out_of_error_file(tmp_path) -> None:
    record_collab_event(
        "project_flush_succeeded",
        level="info",
        project_id="project-1",
        operation="compile",
        details={"flushed_doc_ids": ["doc-1"]},
        log_dir=tmp_path,
    )

    payload = json.loads((tmp_path / "collaboration.log").read_text().strip())

    assert payload["event"] == "project_flush_succeeded"
    assert payload["details"] == {"flushed_doc_ids": ["doc-1"]}
    assert not (tmp_path / "collaboration-errors.log").exists()


@pytest.mark.asyncio
async def test_project_flush_records_success_event(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[dict] = []
    project = Project(id="project-1", name="Project One", user_id="owner")

    async def fake_snapshot(project_id: str) -> list[str]:
        assert project_id == "project-1"
        return ["doc-1", "doc-2"]

    monkeypatch.setattr(
        collab_consistency.collab_snapshot_service,
        "snapshot_project_from_collab",
        fake_snapshot,
    )
    monkeypatch.setattr(
        collab_consistency,
        "record_collab_event",
        lambda event, **kwargs: events.append({"event": event, **kwargs}),
    )

    assert await collab_consistency.flush_project_collab_or_503(project) == ["doc-1", "doc-2"]

    assert events == [
        {
            "event": "project_flush_succeeded",
            "project_id": "project-1",
            "operation": "project_flush",
            "details": {"flushed_doc_ids": ["doc-1", "doc-2"], "count": 2},
        }
    ]


@pytest.mark.asyncio
async def test_project_flush_records_failure_event(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[dict] = []
    project = Project(id="project-1", name="Project One", user_id="owner")

    async def fake_snapshot(project_id: str) -> list[str]:
        raise CollabSnapshotError("collab server down")

    monkeypatch.setattr(
        collab_consistency.collab_snapshot_service,
        "snapshot_project_from_collab",
        fake_snapshot,
    )
    monkeypatch.setattr(
        collab_consistency,
        "record_collab_event",
        lambda event, **kwargs: events.append({"event": event, **kwargs}),
    )

    with pytest.raises(HTTPException) as exc:
        await collab_consistency.flush_project_collab_or_503(project)

    assert exc.value.status_code == 503
    assert events == [
        {
            "event": "project_flush_failed",
            "level": "error",
            "project_id": "project-1",
            "operation": "project_flush",
            "code": "collab_flush_failed",
            "message": "collab server down",
        }
    ]


def _doc(*, version: int = 2, project_id: str = "project-1") -> Doc:
    return Doc(
        id="doc-1",
        project_id=project_id,
        folder_id=None,
        name="main.tex",
        format="tex",
        content="Current",
        version=version,
        updated_at=datetime(2026, 1, 1, 12, 0, 0),
    )


def test_rest_doc_version_conflict_is_logged(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[dict] = []
    project = Project(id="project-1", name="Project One", user_id="owner")
    current = _doc(version=4)

    class FakeProjectFsService:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def get_doc(self, _doc_id: str) -> Doc:
            return current

        def update_doc_content(self, *_args, **_kwargs) -> Doc:
            raise DocVersionConflictError(current)

    monkeypatch.setattr(filesystem_api, "ProjectFsService", FakeProjectFsService)
    monkeypatch.setattr(
        filesystem_api,
        "record_collab_event",
        lambda event, **kwargs: events.append({"event": event, **kwargs}),
    )

    with pytest.raises(HTTPException) as exc:
        filesystem_api.update_doc(
            "doc-1",
            DocUpdateIn(content="Mine", base_version=3, origin="manual"),
            db=None,
            project=project,
            x_client_id="client-1",
        )

    assert exc.value.status_code == 409
    assert events == [
        {
            "event": "doc_version_conflict",
            "level": "warning",
            "project_id": "project-1",
            "doc_id": "doc-1",
            "operation": "manual",
            "code": "doc_version_conflict",
            "details": {
                "expected_version": 3,
                "current_version": 4,
                "client_id": "client-1",
            },
        }
    ]


@pytest.mark.asyncio
async def test_collab_doc_flush_failure_is_logged(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[dict] = []
    project = Project(id="project-1", name="Project One", user_id="owner")
    existing = _doc()

    class FakeProjectFsService:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def get_doc(self, _doc_id: str) -> Doc:
            return existing

    async def fake_snapshot(_doc_id: str) -> Doc:
        raise CollabSnapshotError("upstream timeout")

    monkeypatch.setattr(filesystem_api, "ProjectFsService", FakeProjectFsService)
    monkeypatch.setattr(filesystem_api.collab_snapshot_service, "snapshot_doc_from_collab", fake_snapshot)
    monkeypatch.setattr(
        filesystem_api,
        "record_collab_event",
        lambda event, **kwargs: events.append({"event": event, **kwargs}),
    )

    with pytest.raises(HTTPException) as exc:
        await filesystem_api.flush_collab_doc("doc-1", db=None, project=project, x_client_id="client-1")

    assert exc.value.status_code == 503
    assert events == [
        {
            "event": "collab_doc_flush_failed",
            "level": "error",
            "project_id": "project-1",
            "doc_id": "doc-1",
            "operation": "collab_flush",
            "code": "collab_flush_failed",
            "message": "upstream timeout",
            "details": {"client_id": "client-1"},
        }
    ]


@pytest.mark.asyncio
async def test_collab_doc_not_ready_is_logged(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[dict] = []
    project = Project(id="project-1", name="Project One", user_id="owner")
    existing = _doc()

    class FakeProjectFsService:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def get_doc(self, _doc_id: str) -> Doc:
            return existing

    async def fake_snapshot(_doc_id: str) -> None:
        return None

    monkeypatch.setattr(filesystem_api, "ProjectFsService", FakeProjectFsService)
    monkeypatch.setattr(filesystem_api.collab_snapshot_service, "snapshot_doc_from_collab", fake_snapshot)
    monkeypatch.setattr(
        filesystem_api,
        "record_collab_event",
        lambda event, **kwargs: events.append({"event": event, **kwargs}),
    )

    with pytest.raises(HTTPException) as exc:
        await filesystem_api.flush_collab_doc("doc-1", db=None, project=project, x_client_id="client-1")

    assert exc.value.status_code == 503
    assert events == [
        {
            "event": "collab_doc_not_ready",
            "level": "warning",
            "project_id": "project-1",
            "doc_id": "doc-1",
            "operation": "collab_flush",
            "code": "collab_doc_not_ready",
            "details": {"client_id": "client-1"},
        }
    ]

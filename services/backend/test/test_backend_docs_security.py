from __future__ import annotations

from fastapi.testclient import TestClient

from app import main as backend_main


def test_api_docs_and_openapi_are_disabled_by_default(monkeypatch) -> None:
    monkeypatch.setattr(backend_main, "init_db", lambda: None)

    app = backend_main.create_app()
    client = TestClient(app)

    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_api_docs_can_be_enabled_explicitly(monkeypatch) -> None:
    monkeypatch.setattr(backend_main, "init_db", lambda: None)
    monkeypatch.setitem(backend_main.settings.__dict__, "api_docs_enabled", True)

    app = backend_main.create_app()
    client = TestClient(app)

    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200

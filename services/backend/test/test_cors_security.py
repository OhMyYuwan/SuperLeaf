from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app.settings import settings


def test_cors_rejects_unconfigured_private_lan_origin_by_default() -> None:
    client = _cors_client()

    response = client.get("/ping", headers={"Origin": "http://192.168.1.42:5173"})

    assert "access-control-allow-origin" not in response.headers


def test_cors_rejects_random_localhost_port_by_default() -> None:
    client = _cors_client()

    response = client.get("/ping", headers={"Origin": "http://localhost:9999"})

    assert "access-control-allow-origin" not in response.headers


def test_cors_allows_configured_frontend_origin_with_credentials() -> None:
    client = _cors_client()

    response = client.get("/ping", headers={"Origin": "http://localhost:5173"})

    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert response.headers["access-control-allow-credentials"] == "true"


def test_cors_dev_private_origin_regex_requires_explicit_opt_in(monkeypatch) -> None:
    monkeypatch.setattr(settings, "cors_origins", [])
    monkeypatch.setattr(settings, "cors_origin_regex", "")
    if hasattr(settings, "dev_cors_private_origins_enabled"):
        monkeypatch.setattr(settings, "dev_cors_private_origins_enabled", True)
    else:
        monkeypatch.setitem(settings.__dict__, "dev_cors_private_origins_enabled", True)
    client = _cors_client()

    response = client.get("/ping", headers={"Origin": "http://10.1.2.3:5173"})

    assert response.headers["access-control-allow-origin"] == "http://10.1.2.3:5173"
    assert response.headers["access-control-allow-credentials"] == "true"


def _cors_client() -> TestClient:
    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=_resolved_cors_origin_regex(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/ping")
    def ping() -> dict[str, bool]:
        return {"ok": True}

    return TestClient(app)


def _resolved_cors_origin_regex() -> str | None:
    resolver = getattr(settings, "resolved_cors_origin_regex", None)
    if callable(resolver):
        return resolver()
    return settings.cors_origin_regex

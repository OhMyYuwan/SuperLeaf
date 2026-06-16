"""FastAPI entrypoint."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import api_router
from .database import init_db
from .services.collab_snapshot_service import start_snapshot_loop, stop_snapshot_loop
from .settings import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_snapshot_loop()
    yield
    stop_snapshot_loop()


def create_app() -> FastAPI:
    init_db()

    app = FastAPI(
        title="SuperLeaf Backend",
        description="FastAPI proxy to Dify + local document/annotation/history persistence.",
        version="0.0.1",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.resolved_cors_origin_regex(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router)
    if settings.mcp_server_enabled:
        from .mcp.router import router as backend_mcp_router

        app.include_router(backend_mcp_router)
    return app


app = create_app()

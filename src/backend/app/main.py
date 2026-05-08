"""FastAPI entrypoint."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import api_router
from .database import init_db
from .settings import settings


def create_app() -> FastAPI:
    init_db()

    app = FastAPI(
        title="YuwanLabWriter Backend",
        description="FastAPI proxy to Dify + local document/annotation/history persistence.",
        version="0.0.1",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router)
    return app


app = create_app()

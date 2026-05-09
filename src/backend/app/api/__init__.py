"""FastAPI route aggregation."""

from fastapi import APIRouter

from . import compile, conversations, filesystem, health, providers, workflows

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(providers.router)
api_router.include_router(workflows.router)
api_router.include_router(filesystem.router)
api_router.include_router(conversations.router)
api_router.include_router(compile.router)

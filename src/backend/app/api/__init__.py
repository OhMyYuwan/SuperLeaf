"""FastAPI route aggregation."""

from fastapi import APIRouter

from . import health, providers, workflows

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(providers.router)
api_router.include_router(workflows.router)

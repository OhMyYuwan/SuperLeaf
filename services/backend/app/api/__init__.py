"""FastAPI route aggregation."""

from fastapi import APIRouter

from . import (
    annotation_evaluations,
    archives,
    auth,
    compile,
    conversations,
    filesystem,
    github,
    health,
    notifications,
    projects,
    providers,
    users,
    versions,
    workflow_test_cases,
    workflows,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(providers.router)
api_router.include_router(projects.router)
api_router.include_router(workflows.router)
api_router.include_router(workflow_test_cases.router)
api_router.include_router(filesystem.router)
api_router.include_router(filesystem.projects_router)
api_router.include_router(github.router)
api_router.include_router(conversations.router)
api_router.include_router(versions.router)
api_router.include_router(annotation_evaluations.router)
api_router.include_router(archives.router)
api_router.include_router(compile.router)
api_router.include_router(compile.projects_router)
api_router.include_router(notifications.router)

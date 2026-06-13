"""FastAPI route aggregation."""

from fastapi import APIRouter

from . import (
    annotation_evaluations,
    archives,
    auth,
    compile,
    conversations,
    datasets,
    filesystem,
    github,
    health,
    major_versions,
    mcp,
    mcp_rpc,
    native_agents,
    notifications,
    projects,
    providers,
    spelling,
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
api_router.include_router(spelling.router)
api_router.include_router(native_agents.router)
api_router.include_router(projects.router)
api_router.include_router(workflows.router)
api_router.include_router(workflow_test_cases.router)
api_router.include_router(filesystem.router)
api_router.include_router(filesystem.projects_router)
api_router.include_router(github.router)
api_router.include_router(conversations.router)
api_router.include_router(datasets.router)
api_router.include_router(versions.router)
api_router.include_router(annotation_evaluations.router)
api_router.include_router(archives.router)
api_router.include_router(major_versions.router)
api_router.include_router(compile.router)
api_router.include_router(compile.projects_router)
api_router.include_router(notifications.router)
api_router.include_router(mcp.router)
api_router.include_router(mcp_rpc.router)

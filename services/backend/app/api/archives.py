"""Project-level archive and GitHub binding routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Doc, Project, User
from ..schemas import (
    GitHubImportIn,
    GitHubImportOut,
    GitHubPushIn,
    GitHubPushOut,
    ProjectArchiveBindingIn,
    ProjectArchiveBindingOut,
    ProjectArchiveSnapshotIn,
    ProjectArchiveSnapshotOut,
    ProjectArchiveStatusOut,
)
from ..services.github_service import GitHubError, GitHubService
from ..services.project_archive_service import ArchiveError, ProjectArchiveService
from .collab_consistency import (
    flush_project_collab_or_503_sync,
    invalidate_collab_docs_or_503_sync,
    sync_project_collab_from_db_or_503_sync,
)
from .deps import get_current_user, get_project_from_path

router = APIRouter(prefix="/api/projects/{project_id}/archive", tags=["archive"])


def _require_owner(project: Project, user: User) -> None:
    if project.user_id != user.id:
        raise HTTPException(403, "Only the project owner can publish archive versions")


def _binding_out(binding) -> ProjectArchiveBindingOut:
    return ProjectArchiveBindingOut.model_validate(binding)


@router.get("/status", response_model=ProjectArchiveStatusOut)
def archive_status(
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectArchiveStatusOut:
    svc = ProjectArchiveService(db, project, user)
    binding, snapshots, local_dirty = svc.status()
    return ProjectArchiveStatusOut(
        binding=_binding_out(binding),
        snapshots=[ProjectArchiveSnapshotOut.model_validate(s) for s in snapshots],
        local_dirty=local_dirty,
        remote_configured=bool(binding.github_owner and binding.github_repo),
    )


@router.put("/github", response_model=ProjectArchiveBindingOut)
def configure_github_archive(
    body: ProjectArchiveBindingIn,
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectArchiveBindingOut:
    _require_owner(project, user)
    svc = ProjectArchiveService(db, project, user)
    try:
        binding = svc.configure_github(
            repo_url=body.github_repo_url,
            owner=body.github_owner,
            repo=body.github_repo,
            branch=body.github_branch,
            path=body.github_path,
            private_required=body.github_private_required,
        )
    except ArchiveError as e:
        raise HTTPException(400, str(e)) from e
    return _binding_out(binding)


@router.post("/github/import", response_model=GitHubImportOut)
def import_github_repository(
    body: GitHubImportIn,
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> GitHubImportOut:
    _require_owner(project, user)
    flushed_doc_ids = flush_project_collab_or_503_sync(project)
    db.expire_all()
    try:
        result = GitHubService(db, user).import_repo_into_project(
            project,
            repo_url=body.repo_url,
            branch=body.branch,
        )
    except GitHubError as e:
        raise HTTPException(400, str(e)) from e
    db.expire_all()
    sync_project_collab_from_db_or_503_sync(
        db,
        project,
        operation="github_import",
    )
    current_doc_ids = {
        str(row[0])
        for row in db.query(Doc.id).filter(Doc.project_id == project.id).all()
    }
    stale_doc_ids = [doc_id for doc_id in flushed_doc_ids if doc_id not in current_doc_ids]
    invalidate_collab_docs_or_503_sync(
        project,
        stale_doc_ids,
        operation="github_import_stale_doc",
    )
    return GitHubImportOut(
        project_id=project.id,
        repo_url=result.repo_url,
        branch=result.branch,
        doc_count=result.doc_count,
        file_count=result.file_count,
        byte_count=result.byte_count,
    )


@router.post("/github/push", response_model=GitHubPushOut)
def push_github_archive(
    body: GitHubPushIn,
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> GitHubPushOut:
    _require_owner(project, user)
    flush_project_collab_or_503_sync(project)
    db.expire_all()
    svc = ProjectArchiveService(db, project, user)
    try:
        binding, _snapshot, sha = svc.push_to_github(body.message)
    except ArchiveError as e:
        raise HTTPException(400, str(e)) from e
    repo_url = binding.github_repo_url or f"https://github.com/{binding.github_owner}/{binding.github_repo}"
    return GitHubPushOut(
        project_id=project.id,
        repo_url=repo_url,
        branch=binding.github_branch,
        commit_sha=sha,
        pushed=True,
    )


@router.post("/snapshots", response_model=ProjectArchiveSnapshotOut, status_code=201)
def create_archive_snapshot(
    body: ProjectArchiveSnapshotIn,
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectArchiveSnapshotOut:
    _require_owner(project, user)
    flush_project_collab_or_503_sync(project)
    db.expire_all()
    svc = ProjectArchiveService(db, project, user)
    try:
        snapshot = svc.create_snapshot(body.message)
    except ArchiveError as e:
        raise HTTPException(400, str(e)) from e
    return ProjectArchiveSnapshotOut.model_validate(snapshot)


@router.get("/snapshots", response_model=list[ProjectArchiveSnapshotOut])
def list_archive_snapshots(
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[ProjectArchiveSnapshotOut]:
    svc = ProjectArchiveService(db, project, user)
    return [ProjectArchiveSnapshotOut.model_validate(s) for s in svc.list_snapshots()]

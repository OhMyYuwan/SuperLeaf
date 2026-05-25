"""Major version (git commit) management routes."""

from __future__ import annotations

import base64

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database import get_session
from ..models import Project, User
from ..schemas import (
    CommitDiffOut,
    CommitMetaOut,
    FileEntryOut,
    FileDiffOut,
    MajorVersionCreateIn,
    MajorVersionRestoreIn,
    ProjectArchiveSnapshotOut,
)
from ..services.project_archive_service import ArchiveError, ProjectArchiveService
from .deps import get_current_user, get_project_from_path

router = APIRouter(prefix="/api/projects/{project_id}/major-versions", tags=["major-versions"])


def _require_owner(project: Project, user: User) -> None:
    if project.user_id != user.id:
        raise HTTPException(403, "Only the project owner can manage major versions")


@router.get("", response_model=list[CommitMetaOut])
def list_major_versions(
    limit: int = Query(default=50, ge=1, le=200),
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[CommitMetaOut]:
    """List recent commits from the project archive repo."""
    svc = ProjectArchiveService(db, project, user)
    try:
        commits = svc.list_commits(limit=limit)
    except ArchiveError as e:
        raise HTTPException(400, str(e)) from e
    return [
        CommitMetaOut(
            sha=c.sha,
            short_sha=c.short_sha,
            message=c.message,
            author_name=c.author_name,
            author_email=c.author_email,
            date=c.date,
            insertions=c.insertions,
            deletions=c.deletions,
            files_changed=c.files_changed,
        )
        for c in commits
    ]


@router.post("", response_model=ProjectArchiveSnapshotOut, status_code=201)
def create_major_version(
    body: MajorVersionCreateIn,
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectArchiveSnapshotOut:
    """Create a new major version (git commit) of the entire project."""
    _require_owner(project, user)
    svc = ProjectArchiveService(db, project, user)
    try:
        snapshot = svc.create_snapshot(body.message)
    except ArchiveError as e:
        raise HTTPException(400, str(e)) from e
    return ProjectArchiveSnapshotOut.model_validate(snapshot)


@router.get("/{sha}", response_model=dict)
def get_major_version_detail(
    sha: str,
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Get commit details including file list."""
    svc = ProjectArchiveService(db, project, user)
    try:
        files = svc.list_commit_files(sha)
    except ArchiveError as e:
        raise HTTPException(400, str(e)) from e
    return {
        "sha": sha,
        "files": [
            FileEntryOut(path=f.path, blob_sha=f.blob_sha, size=f.size)
            for f in files
        ],
    }


@router.get("/{sha}/diff", response_model=CommitDiffOut)
def get_major_version_diff(
    sha: str,
    against: str | None = Query(default=None),
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> CommitDiffOut:
    """Get diff between two commits."""
    svc = ProjectArchiveService(db, project, user)
    try:
        diff = svc.get_commit_diff(sha, against=against)
    except ArchiveError as e:
        raise HTTPException(400, str(e)) from e
    return CommitDiffOut(
        from_sha=diff.from_sha,
        to_sha=diff.to_sha,
        files=[
            FileDiffOut(
                path=f.path,
                status=f.status,
                insertions=f.insertions,
                deletions=f.deletions,
                patch=f.patch,
            )
            for f in diff.files
        ],
        total_insertions=diff.total_insertions,
        total_deletions=diff.total_deletions,
        files_changed=diff.files_changed,
    )


@router.get("/{sha}/files/{path:path}", response_model=dict)
def get_major_version_file(
    sha: str,
    path: str,
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Read a file from a specific commit."""
    svc = ProjectArchiveService(db, project, user)
    try:
        content = svc.read_commit_file(sha, path)
    except ArchiveError as e:
        raise HTTPException(400, str(e)) from e

    # Try to decode as UTF-8, otherwise return base64
    try:
        text = content.decode("utf-8")
        return {"path": path, "content": text, "encoding": "utf-8"}
    except UnicodeDecodeError:
        b64 = base64.b64encode(content).decode("ascii")
        return {"path": path, "content": b64, "encoding": "base64"}


@router.post("/{sha}/restore", response_model=ProjectArchiveSnapshotOut, status_code=201)
def restore_major_version(
    sha: str,
    body: MajorVersionRestoreIn,
    project: Project = Depends(get_project_from_path),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ProjectArchiveSnapshotOut:
    """Safely restore project to a specific commit (creates a new commit, no history rewrite)."""
    _require_owner(project, user)
    svc = ProjectArchiveService(db, project, user)
    try:
        snapshot = svc.restore_to_commit(sha, message=body.message)
    except ArchiveError as e:
        raise HTTPException(400, str(e)) from e
    return ProjectArchiveSnapshotOut.model_validate(snapshot)


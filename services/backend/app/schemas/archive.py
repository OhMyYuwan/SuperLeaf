"""项目归档绑定、快照与版本 diff schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ProjectArchiveBindingIn(BaseModel):
    github_repo_url: str = Field(default="", max_length=512)
    github_owner: str = Field(default="", max_length=128)
    github_repo: str = Field(default="", max_length=128)
    github_branch: str = Field(default="yuwanlab-archive", min_length=1, max_length=128)
    github_path: str = Field(default="", max_length=512)
    github_private_required: bool = False


class ProjectArchiveBindingOut(BaseModel):
    project_id: str
    local_repo_path: str
    github_account_id: str = ""
    github_repo_url: str = ""
    github_owner: str
    github_repo: str
    github_branch: str
    github_path: str
    github_private_required: bool
    github_bound_at: datetime | None
    last_local_commit_sha: str
    last_pushed_commit_sha: str

    class Config:
        from_attributes = True


class ProjectArchiveSnapshotIn(BaseModel):
    message: str | None = Field(default=None, max_length=512)


class ProjectArchiveSnapshotOut(BaseModel):
    id: str
    project_id: str
    commit_sha: str
    message: str
    doc_count: int
    file_count: int
    byte_count: int
    pushed_to_github: bool
    created_at: datetime

    class Config:
        from_attributes = True


class ProjectArchiveStatusOut(BaseModel):
    binding: ProjectArchiveBindingOut
    snapshots: list[ProjectArchiveSnapshotOut] = Field(default_factory=list)
    local_dirty: bool = False
    remote_configured: bool = False


class CommitMetaOut(BaseModel):
    sha: str
    short_sha: str
    message: str
    author_name: str
    author_email: str
    date: str
    insertions: int
    deletions: int
    files_changed: int


class FileEntryOut(BaseModel):
    path: str
    blob_sha: str
    size: int


class FileDiffOut(BaseModel):
    path: str
    status: str
    insertions: int
    deletions: int
    patch: str | None


class CommitDiffOut(BaseModel):
    from_sha: str
    to_sha: str
    files: list[FileDiffOut]
    total_insertions: int
    total_deletions: int
    files_changed: int


class MajorVersionCreateIn(BaseModel):
    message: str = Field(min_length=1, max_length=2048)


class MajorVersionRestoreIn(BaseModel):
    message: str | None = Field(default=None, max_length=512)

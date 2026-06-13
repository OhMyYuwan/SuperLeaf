"""GitHub 账号、OAuth/device 与 import/push schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class GitHubAccountOut(BaseModel):
    connected: bool
    login: str = ""
    name: str = ""
    avatar_url: str = ""
    scope: str = ""
    updated_at: datetime | None = None


class GitHubTokenConnectIn(BaseModel):
    token: str = Field(min_length=1, max_length=4096)


class GitHubOAuthStartOut(BaseModel):
    authorize_url: str


class GitHubDeviceStartIn(BaseModel):
    client_id: str | None = Field(default=None, max_length=128)
    scope: str = Field(default="repo", max_length=512)


class GitHubDeviceStartOut(BaseModel):
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str = ""
    expires_in: int
    interval: int


class GitHubDevicePollIn(BaseModel):
    client_id: str | None = Field(default=None, max_length=128)
    device_code: str = Field(min_length=1, max_length=512)


class GitHubDevicePollOut(BaseModel):
    status: str
    error: str = ""
    interval: int | None = None
    account: GitHubAccountOut | None = None


class GitHubImportIn(BaseModel):
    repo_url: str = Field(min_length=1, max_length=512)
    branch: str | None = Field(default=None, max_length=128)


class GitHubImportOut(BaseModel):
    project_id: str
    repo_url: str
    branch: str
    doc_count: int
    file_count: int
    byte_count: int


class GitHubPushIn(BaseModel):
    message: str | None = Field(default=None, max_length=512)


class GitHubPushOut(BaseModel):
    project_id: str
    repo_url: str
    branch: str
    commit_sha: str
    pushed: bool

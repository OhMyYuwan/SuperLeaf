"""项目本体、成员与编译设置 schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ProjectOut(BaseModel):
    id: str
    user_id: str
    name: str
    main_doc_id: str
    compiler: str
    project_type: str = "paper"
    is_skill_project: bool = False
    project_skill_id: str = ""
    skill_cache_version: int = 0
    skill_cache_updated_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    my_role: str = "owner"

    class Config:
        from_attributes = True


class ProjectCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    project_type: str = Field(default="paper", pattern="^(paper|skill|data)$")


class GitHubProjectImportIn(BaseModel):
    repo_url: str = Field(min_length=1, max_length=512)
    branch: str | None = Field(default=None, max_length=128)
    name: str | None = Field(default=None, max_length=128)


class ProjectUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    main_doc_id: str | None = None
    compiler: str | None = None
    is_skill_project: bool | None = None
    project_type: str | None = Field(default=None, pattern="^(paper|skill|data)$")


class ProjectMemberAddIn(BaseModel):
    email: str = Field(min_length=1, max_length=255)
    role: str = Field(default="editor", pattern="^(editor|viewer)$")


class ProjectMemberOut(BaseModel):
    id: str
    project_id: str
    user_id: str
    user_email: str
    user_display_name: str
    role: str
    status: str
    created_at: datetime

    class Config:
        from_attributes = True


class RecentCollaboratorOut(BaseModel):
    id: str
    user_id: str
    email: str
    display_name: str
    last_collaborated_at: datetime


class ProjectCompileSettingsIn(BaseModel):
    main_doc_id: str | None = None
    compiler: str | None = None


class ProjectCompileSettingsOut(BaseModel):
    main_doc_id: str
    compiler: str

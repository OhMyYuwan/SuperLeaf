"""Skill 库、市场与项目 Skill 缓存 schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from .project import ProjectOut


class SkillIn(BaseModel):
    name: str = Field(default="", max_length=128)
    folder_name: str = Field(default="", max_length=128)
    entry_filename: str = Field(default="SKILL.md", max_length=64)
    description: str = ""
    content: str = Field(min_length=1, max_length=60000)
    tags: list[str] = Field(default_factory=list)


class SkillRecipeIn(BaseModel):
    name: str = Field(default="", max_length=128)
    description: str = ""
    repo_url: str = Field(default="", max_length=1024)
    source_url: str = Field(default="", max_length=1200)
    source_ref: str = Field(default="", max_length=128)
    skill_name: str = Field(default="", max_length=256)
    install_command: str = Field(default="", max_length=2048)
    tags: list[str] = Field(default_factory=list)


class SkillPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    content: str | None = Field(default=None, max_length=60000)
    tags: list[str] | None = None


class SkillOut(BaseModel):
    id: str
    owner_user_id: str
    name: str
    public_name: str
    description: str
    content: str
    visibility: str
    source: str
    project_id: str = ""
    cache_version: int = 0
    cache_updated_at: datetime | None = None
    version: int
    tags: list[str]
    created_at: datetime
    updated_at: datetime
    published_at: datetime | None
    can_edit: bool = False
    used_by_agent_count: int = 0

    class Config:
        from_attributes = True


class SkillUsageOut(BaseModel):
    """Per-agent reference to a skill, used by the delete-confirmation UI to
    name which Agents will lose this skill."""
    agent_id: str
    agent_name: str
    project_id: str


class SkillMarketplaceEntryOut(BaseModel):
    id: str
    name: str
    display_name: str
    version: str
    author_github: str
    description: str
    tags: list[str]
    license: str
    path: str
    entry: str
    skill_url: str
    entry_url: str
    readme_url: str = ""
    checksum_sha256: str
    repo_url: str = ""
    source_url: str = ""
    source_ref: str = ""
    skill_name: str = ""
    install_command: str = ""
    installed: bool = False
    installed_skill_id: str | None = None
    installed_version: str = ""
    update_available: bool = False


class SkillMarketplaceOut(BaseModel):
    catalog_url: str
    skills: list[SkillMarketplaceEntryOut]


class SkillMarketplaceInstallOut(BaseModel):
    skill: SkillOut
    marketplace_entry: SkillMarketplaceEntryOut


class SkillMarketplaceCloneOut(BaseModel):
    """Response for clone-to-local: returns the new editable local skill."""
    skill: SkillOut


class SkillMarketplaceCloneIn(BaseModel):
    """Request body for clone-to-local: user-provided name for the local copy."""
    name: str = Field(default="", max_length=128)


class NativeAgentSkillRecipeIn(BaseModel):
    source: str = Field(default="marketplace", max_length=32)
    marketplace_id: str = Field(default="", max_length=256)
    repo_url: str = Field(default="", max_length=1024)
    source_url: str = Field(default="", max_length=1200)
    source_ref: str = Field(default="", max_length=128)
    skill_name: str = Field(default="", max_length=256)
    install_command: str = Field(default="", max_length=2048)


class NativeAgentSkillInstallOut(BaseModel):
    id: str
    project_id: str
    user_id: str
    agent_id: str
    skill_id: str = ""
    source: str
    marketplace_id: str
    repo_url: str
    source_ref: str
    skill_name: str
    folder_name: str
    install_command: str
    folder_path: str
    manifest: dict
    status: str
    install_log: str
    created_at: datetime
    updated_at: datetime
    installed_at: datetime | None

    class Config:
        from_attributes = True


class ProjectSkillCacheOut(BaseModel):
    project: ProjectOut
    skill: SkillOut


class ProjectSkillDataPackageIn(BaseModel):
    data_project_id: str = Field(min_length=1, max_length=64)
    status: str = Field(
        default="submitted",
        pattern="^(submitted|all|pending|in_review|labeled|discarded)$",
    )


class ProjectSkillDataPackageFileOut(BaseModel):
    path: str
    kind: str
    size_bytes: int


class ProjectSkillDataPackageOut(BaseModel):
    dataset_project_id: str
    dataset_name: str
    status_filter: str
    record_count: int
    folder: str
    files: list[ProjectSkillDataPackageFileOut]
    generated_at: str


class ProjectSkillDataClearOut(BaseModel):
    folder: str
    deleted_count: int

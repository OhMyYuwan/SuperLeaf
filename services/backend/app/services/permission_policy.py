"""Sparse resource/action/API permission policy registry.

This module is a declarative audit surface. Runtime authorization still lives in
FastAPI dependencies and domain services; the registry makes those decisions
indexable and testable without turning permissions into a dense matrix.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

RouteKey = tuple[str, str]
ResourceActionKey = tuple[str, str]
RouteFilter = Callable[[str, str], bool]


class Authority(StrEnum):
    NONE = "none"
    PROJECT_READ = "project_read"
    PROJECT_REVIEW = "project_review"
    PROJECT_WRITE = "project_write"
    PROJECT_OWNER = "project_owner"
    USER_PRIVATE = "user_private"
    SITE_ADMIN = "site_admin"


AUTHORITY_ORDER: dict[Authority, int] = {
    Authority.NONE: 0,
    Authority.PROJECT_READ: 10,
    Authority.PROJECT_REVIEW: 20,
    Authority.PROJECT_WRITE: 30,
    Authority.PROJECT_OWNER: 40,
    Authority.USER_PRIVATE: 40,
    Authority.SITE_ADMIN: 50,
}


class OwnershipBoundary(StrEnum):
    PUBLIC = "public"
    USER_PRIVATE = "user_private"
    PROJECT_MEMBERSHIP = "project_membership"
    PROJECT_OWNER = "project_owner"
    SITE_ADMIN = "site_admin"
    NO_DIRECT_ACCESS = "no_direct_access"


@dataclass(frozen=True, slots=True)
class ResourcePolicy:
    key: str
    model: str
    boundary: OwnershipBoundary
    owner_field: str = ""
    parent_resource: str = ""
    parent_field: str = ""
    direct_api_lookup: bool = True
    notes: str = ""


@dataclass(frozen=True, slots=True)
class ActionPolicy:
    resource: str
    action: str
    required: Authority
    helper: str
    expected_foreign_status: int = 404
    notes: str = ""


@dataclass(frozen=True, slots=True)
class ApiPolicy:
    method: str
    path: str
    resource: str
    action: str
    auth_surface: str
    helper: str
    expected_foreign_status: int = 404
    notes: str = ""

    @property
    def key(self) -> RouteKey:
        return (self.method.upper(), self.path)


@dataclass(frozen=True, slots=True)
class McpTransportPolicy:
    method: str
    path: str
    auth_surface: str
    helper: str
    notes: str = ""

    @property
    def key(self) -> RouteKey:
        return (self.method.upper(), self.path)


@dataclass(frozen=True, slots=True)
class AgentCommandPolicy:
    name: str
    resource: str
    action: str
    auth_surface: str
    helper: str
    expected_foreign_status: int = 404
    notes: str = ""


@dataclass(frozen=True, slots=True)
class CrossUserTestPolicy:
    resource: str
    action: str
    test_module: str
    evidence: str
    notes: str = ""
    route_keys: tuple[RouteKey, ...] = ()

    @property
    def key(self) -> ResourceActionKey:
        return (self.resource, self.action)

    @property
    def normalized_route_keys(self) -> tuple[RouteKey, ...]:
        return tuple((method.upper(), path) for method, path in self.route_keys)


@dataclass(frozen=True, slots=True)
class ApiRouteCrossUserEvidence:
    method: str
    path: str
    resource: str
    action: str
    auth_surface: str
    expected_foreign_status: int
    test_module: str
    evidence: str


@dataclass(frozen=True, slots=True)
class CrossUserRouteFanout:
    resource: str
    action: str
    test_module: str
    evidence: str
    route_count: int
    routes: tuple[RouteKey, ...]


@dataclass(frozen=True, slots=True)
class McpTransportTestPolicy:
    method: str
    path: str
    test_module: str
    evidence: str
    notes: str = ""

    @property
    def key(self) -> RouteKey:
        return (self.method.upper(), self.path)


@dataclass(frozen=True, slots=True)
class AgentCommandTestPolicy:
    name: str
    test_module: str
    evidence: str
    notes: str = ""


@dataclass(frozen=True, slots=True)
class McpTransportEvidence:
    method: str
    path: str
    auth_surface: str
    test_module: str
    evidence: str


@dataclass(frozen=True, slots=True)
class AgentCommandEvidence:
    name: str
    resource: str
    action: str
    auth_surface: str
    expected_foreign_status: int
    test_module: str
    evidence: str


def satisfies(*, actual: Authority, required: Authority) -> bool:
    """Return whether an actual authority can satisfy a required authority."""
    if required is Authority.USER_PRIVATE:
        return actual in {Authority.USER_PRIVATE, Authority.SITE_ADMIN}
    if actual is Authority.USER_PRIVATE:
        return required is Authority.USER_PRIVATE
    return AUTHORITY_ORDER[actual] >= AUTHORITY_ORDER[required]


RESOURCE_POLICIES: dict[str, ResourcePolicy] = {
    "health": ResourcePolicy("health", "", OwnershipBoundary.PUBLIC),
    "user": ResourcePolicy("user", "User", OwnershipBoundary.USER_PRIVATE, owner_field="id"),
    "session": ResourcePolicy("session", "Session", OwnershipBoundary.USER_PRIVATE, owner_field="user_id"),
    "registration_invite": ResourcePolicy(
        "registration_invite",
        "RegistrationInvite",
        OwnershipBoundary.SITE_ADMIN,
        owner_field="created_by_user_id",
    ),
    "mcp_token": ResourcePolicy(
        "mcp_token", "McpToken", OwnershipBoundary.USER_PRIVATE, owner_field="user_id"
    ),
    "github_account": ResourcePolicy(
        "github_account", "GitHubAccount", OwnershipBoundary.USER_PRIVATE, owner_field="user_id"
    ),
    "github_oauth_state": ResourcePolicy(
        "github_oauth_state",
        "GitHubOAuthState",
        OwnershipBoundary.USER_PRIVATE,
        owner_field="user_id",
        direct_api_lookup=False,
    ),
    "spelling_preference": ResourcePolicy(
        "spelling_preference", "SpellingPreference", OwnershipBoundary.USER_PRIVATE, owner_field="user_id"
    ),
    "provider": ResourcePolicy("provider", "Provider", OwnershipBoundary.USER_PRIVATE, owner_field="user_id"),
    "compile_environment": ResourcePolicy(
        "compile_environment",
        "",
        OwnershipBoundary.USER_PRIVATE,
        notes="Compiler metadata is authenticated; compiler rescans are site-admin only.",
    ),
    "local_agent_host_package": ResourcePolicy(
        "local_agent_host_package",
        "",
        OwnershipBoundary.USER_PRIVATE,
        notes="Download/package metadata is gated by an authenticated user session.",
    ),
    "mcp_catalog": ResourcePolicy(
        "mcp_catalog",
        "",
        OwnershipBoundary.USER_PRIVATE,
        notes="Remote catalog reads and probes are authenticated configuration surfaces.",
    ),
    "official_badge_ui": ResourcePolicy(
        "official_badge_ui",
        "",
        OwnershipBoundary.USER_PRIVATE,
        notes="Runtime UI preference toggle; not persisted per user yet but exposed only to sessions.",
    ),
    "cached_workflow": ResourcePolicy(
        "cached_workflow", "CachedWorkflow", OwnershipBoundary.USER_PRIVATE, owner_field="user_id"
    ),
    "native_agent_credential": ResourcePolicy(
        "native_agent_credential",
        "NativeAgentCredential",
        OwnershipBoundary.USER_PRIVATE,
        owner_field="user_id",
    ),
    "native_mcp_server": ResourcePolicy(
        "native_mcp_server", "NativeMcpServer", OwnershipBoundary.USER_PRIVATE, owner_field="user_id"
    ),
    "skill": ResourcePolicy(
        "skill",
        "Skill",
        OwnershipBoundary.USER_PRIVATE,
        owner_field="owner_user_id",
        notes="Project-backed and public skills add project/visibility rules at service level.",
    ),
    "skill_hidden": ResourcePolicy(
        "skill_hidden", "SkillHidden", OwnershipBoundary.USER_PRIVATE, owner_field="user_id"
    ),
    "project": ResourcePolicy(
        "project", "Project", OwnershipBoundary.PROJECT_MEMBERSHIP, owner_field="user_id"
    ),
    "project_member": ResourcePolicy(
        "project_member",
        "ProjectMember",
        OwnershipBoundary.PROJECT_OWNER,
        parent_resource="project",
        parent_field="project_id",
    ),
    "recent_collaborator": ResourcePolicy(
        "recent_collaborator",
        "RecentCollaborator",
        OwnershipBoundary.USER_PRIVATE,
        owner_field="owner_user_id",
    ),
    "dataset_project": ResourcePolicy(
        "dataset_project",
        "DatasetProject",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="project",
        parent_field="project_id",
    ),
    "dataset_source_rule": ResourcePolicy(
        "dataset_source_rule",
        "DatasetSourceRule",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="dataset_project",
        parent_field="dataset_project_id",
    ),
    "dataset_batch": ResourcePolicy(
        "dataset_batch",
        "DatasetBatch",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="dataset_project",
        parent_field="dataset_project_id",
    ),
    "dataset_record": ResourcePolicy(
        "dataset_record",
        "DatasetRecord",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="dataset_project",
        parent_field="dataset_project_id",
    ),
    "dataset_response": ResourcePolicy(
        "dataset_response",
        "DatasetResponse",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="dataset_project",
        parent_field="dataset_project_id",
    ),
    "project_archive_binding": ResourcePolicy(
        "project_archive_binding",
        "ProjectArchiveBinding",
        OwnershipBoundary.PROJECT_OWNER,
        parent_resource="project",
        parent_field="project_id",
    ),
    "project_archive_snapshot": ResourcePolicy(
        "project_archive_snapshot",
        "ProjectArchiveSnapshot",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="project",
        parent_field="project_id",
    ),
    "folder": ResourcePolicy(
        "folder",
        "Folder",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="project",
        parent_field="project_id",
    ),
    "doc": ResourcePolicy(
        "doc",
        "Doc",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="project",
        parent_field="project_id",
    ),
    "file_blob": ResourcePolicy(
        "file_blob",
        "FileBlob",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="project",
        parent_field="project_id",
    ),
    "conversation": ResourcePolicy(
        "conversation",
        "Conversation",
        OwnershipBoundary.USER_PRIVATE,
        owner_field="user_id",
        parent_resource="project",
        parent_field="project_id",
    ),
    "message": ResourcePolicy(
        "message",
        "Message",
        OwnershipBoundary.USER_PRIVATE,
        parent_resource="conversation",
        parent_field="conversation_id",
        direct_api_lookup=False,
    ),
    "blob": ResourcePolicy(
        "blob",
        "Blob",
        OwnershipBoundary.NO_DIRECT_ACCESS,
        direct_api_lookup=False,
        notes="Content-addressed storage must only be reached through authorized document versions.",
    ),
    "document_version": ResourcePolicy(
        "document_version",
        "DocumentVersion",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="doc",
        parent_field="doc_id",
        direct_api_lookup=False,
    ),
    "document_label": ResourcePolicy(
        "document_label",
        "DocumentLabel",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="doc",
        parent_field="doc_id",
    ),
    "operation": ResourcePolicy(
        "operation",
        "Operation",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="doc",
        parent_field="doc_id",
    ),
    "annotation": ResourcePolicy(
        "annotation",
        "Annotation",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        parent_resource="doc",
        parent_field="doc_id",
    ),
    "annotation_evaluation": ResourcePolicy(
        "annotation_evaluation",
        "AnnotationEvaluation",
        OwnershipBoundary.USER_PRIVATE,
        owner_field="user_id",
        parent_resource="doc",
        parent_field="doc_id",
    ),
    "annotation_review_state": ResourcePolicy(
        "annotation_review_state",
        "AnnotationReviewState",
        OwnershipBoundary.USER_PRIVATE,
        owner_field="user_id",
        parent_resource="doc",
        parent_field="doc_id",
    ),
    "annotation_agent_suggestion": ResourcePolicy(
        "annotation_agent_suggestion",
        "AnnotationAgentSuggestion",
        OwnershipBoundary.USER_PRIVATE,
        owner_field="user_id",
        parent_resource="doc",
        parent_field="doc_id",
    ),
    "workflow_definition": ResourcePolicy(
        "workflow_definition",
        "WorkflowDefinition",
        OwnershipBoundary.USER_PRIVATE,
        owner_field="user_id",
        parent_resource="project",
        parent_field="project_id",
    ),
    "workflow_test_case": ResourcePolicy(
        "workflow_test_case",
        "WorkflowTestCase",
        OwnershipBoundary.USER_PRIVATE,
        parent_resource="workflow_definition",
        parent_field="definition_id",
        direct_api_lookup=False,
    ),
    "workflow_run": ResourcePolicy(
        "workflow_run",
        "WorkflowRun",
        OwnershipBoundary.USER_PRIVATE,
        owner_field="user_id",
        parent_resource="project",
        parent_field="project_id",
    ),
    "native_agent": ResourcePolicy(
        "native_agent",
        "NativeAgent",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        owner_field="owner_user_id",
        parent_resource="project",
        parent_field="project_id",
    ),
    "native_agent_skill_install": ResourcePolicy(
        "native_agent_skill_install",
        "NativeAgentSkillInstall",
        OwnershipBoundary.PROJECT_MEMBERSHIP,
        owner_field="user_id",
        parent_resource="native_agent",
        parent_field="agent_id",
    ),
    "notification": ResourcePolicy(
        "notification", "Notification", OwnershipBoundary.USER_PRIVATE, owner_field="user_id"
    ),
}


ACTION_POLICIES: dict[tuple[str, str], ActionPolicy] = {}
_ACTION_POLICY_DEFINITIONS: list[ActionPolicy] = []


def _action(
    resource: str,
    action: str,
    required: Authority,
    helper: str,
    *,
    expected_foreign_status: int = 404,
    notes: str = "",
) -> None:
    policy = ActionPolicy(
        resource=resource,
        action=action,
        required=required,
        helper=helper,
        expected_foreign_status=expected_foreign_status,
        notes=notes,
    )
    _ACTION_POLICY_DEFINITIONS.append(policy)
    ACTION_POLICIES[(resource, action)] = policy


_action("health", "read", Authority.NONE, "public health endpoint")
_action("session", "create", Authority.NONE, "AuthService.authenticate/register")
_action("session", "destroy", Authority.NONE, "AuthService.logout")
_action("session", "read", Authority.USER_PRIVATE, "get_current_user")
_action("user", "register", Authority.NONE, "AuthService.register")
_action("user", "admin", Authority.SITE_ADMIN, "require_admin", expected_foreign_status=403)
_action(
    "registration_invite",
    "manage",
    Authority.SITE_ADMIN,
    "require_admin + RegistrationInviteService",
    expected_foreign_status=403,
)
_action("project", "read", Authority.PROJECT_READ, "ProjectMemberService.has_access accepted members")
_action(
    "project",
    "list",
    Authority.USER_PRIVATE,
    "ProjectService.list + ProjectMemberService.list_shared_projects accepted members",
)
_action("project", "create", Authority.USER_PRIVATE, "ProjectService.create")
_action("project", "read_owned", Authority.PROJECT_OWNER, "ProjectService.get user_id owner filter")
_action(
    "project",
    "write_content",
    Authority.PROJECT_WRITE,
    "ProjectMemberService.can_write accepted editors",
)
_action("project", "compile", Authority.PROJECT_WRITE, "require_write_access")
_action("project", "compile_read", Authority.PROJECT_READ, "get_current_project or get_project_from_path")
_action(
    "project",
    "refresh_skill_cache",
    Authority.PROJECT_WRITE,
    "ProjectMemberService.can_write + NativeAgentService.update_project_skill_cache",
)
_action("project", "admin", Authority.PROJECT_OWNER, "project.user_id == user.id")
_action("project", "archive", Authority.PROJECT_OWNER, "archive._require_owner")
_action("project", "delete", Authority.PROJECT_OWNER, "ProjectService.delete")
_action(
    "project_member",
    "manage",
    Authority.PROJECT_OWNER,
    "ProjectMemberService + owner check",
)
_action(
    "project_member",
    "read",
    Authority.PROJECT_READ,
    "get_project_from_path accepted member + list_members accepted roster; owner sees inactive invites",
)
_action("folder", "read", Authority.PROJECT_READ, "get_current_project + ProjectFsService")
_action(
    "folder",
    "write_content",
    Authority.PROJECT_WRITE,
    "require_write_access + ProjectFsService",
)
_action("doc", "read", Authority.PROJECT_READ, "get_current_project + ProjectFsService")
_action(
    "doc",
    "write_content",
    Authority.PROJECT_WRITE,
    "require_write_access + ProjectFsService",
)
_action(
    "doc",
    "issue_collab_token",
    Authority.PROJECT_WRITE,
    "ProjectMemberService.can_write accepted editors",
    expected_foreign_status=403,
)
_action("file_blob", "read", Authority.PROJECT_READ, "ProjectMemberService.has_access accepted members")
_action(
    "file_blob",
    "write_content",
    Authority.PROJECT_WRITE,
    "require_write_access + ProjectFsService",
)
_action("document_version", "read", Authority.PROJECT_READ, "versions._get_doc_or_404")
_action(
    "document_version",
    "restore",
    Authority.PROJECT_WRITE,
    "require_write_access + versions._get_doc_or_404",
)
_action(
    "document_label",
    "write_content",
    Authority.PROJECT_WRITE,
    "require_write_access + versions._get_doc_or_404",
)
_action("operation", "read", Authority.PROJECT_READ, "get_current_project + versions._get_doc_or_404")
_action(
    "operation",
    "write_content",
    Authority.PROJECT_WRITE,
    "require_write_access + versions._get_doc_or_404 + native_agent_runner audit doc/project check",
)
_action("annotation", "read", Authority.PROJECT_READ, "get_current_project + _get_doc_in_project")
_action(
    "annotation",
    "write_content",
    Authority.PROJECT_WRITE,
    "require_write_access or can_write gate",
    expected_foreign_status=403,
)
_action(
    "annotation",
    "manage",
    Authority.USER_PRIVATE,
    "Annotation.user_id == user.id or Annotation.is_global with ProjectMemberService.can_write global write gate",
)
_action(
    "annotation_evaluation",
    "manage",
    Authority.USER_PRIVATE,
    "AnnotationEvaluation.user_id == user.id with AnnotationEvaluation.doc_id/annotation_id scope",
)
_action(
    "annotation_review_state",
    "manage",
    Authority.USER_PRIVATE,
    "AnnotationReviewState.user_id == user.id with AnnotationReviewState.doc_id scope",
)
_action(
    "annotation_agent_suggestion",
    "manage",
    Authority.USER_PRIVATE,
    "AnnotationAgentSuggestion.user_id == user.id and AnnotationAgentSuggestion.project_id == project.id",
)
_action(
    "conversation",
    "manage",
    Authority.USER_PRIVATE,
    "Conversation.project_id == project.id and Conversation.user_id == user.id",
)
_action(
    "message",
    "manage",
    Authority.USER_PRIVATE,
    "parent Conversation.project_id == project.id and Conversation.user_id == user.id; "
    "Message.conversation_id binding",
)
_action(
    "workflow_definition",
    "manage",
    Authority.USER_PRIVATE,
    "WorkflowDefinition.project_id == project.id and WorkflowDefinition.user_id == user.id",
)
_action(
    "workflow_test_case",
    "manage",
    Authority.USER_PRIVATE,
    "workflow_test_cases._require_definition checks WorkflowDefinition.project_id == project.id "
    "and WorkflowDefinition.user_id == user.id",
)
_action(
    "workflow_run",
    "read",
    Authority.USER_PRIVATE,
    "WorkflowRun.project_id == project.id and WorkflowRun.user_id == user.id",
)
_action(
    "workflow_run",
    "manage",
    Authority.USER_PRIVATE,
    "WorkflowRun.project_id == project.id and WorkflowRun.user_id == user.id",
)
_action(
    "provider",
    "manage",
    Authority.USER_PRIVATE,
    "ProviderService provider_id + Provider.user_id owner gates and owner-scoped stats",
)
_action(
    "cached_workflow",
    "manage",
    Authority.USER_PRIVATE,
    "CachedWorkflow.user_id == user.id or AgentRegistryService.resolve native owner/project/provider gates",
)
_action(
    "mcp_token",
    "manage",
    Authority.USER_PRIVATE,
    "McpTokenService scopes token management with McpToken.user_id == user.id",
)
_action(
    "github_account",
    "manage",
    Authority.USER_PRIVATE,
    "GitHubService account/state routes scope GitHubAccount.user_id and GitHubOAuthState.user_id to user.id",
)
_action("compile_environment", "read", Authority.USER_PRIVATE, "get_current_user + compiler info")
_action(
    "compile_environment",
    "admin",
    Authority.SITE_ADMIN,
    "require_admin + compiler rescan",
    expected_foreign_status=403,
)
_action("native_agent", "read", Authority.PROJECT_READ, "NativeAgentService project membership checks")
_action(
    "native_agent",
    "write_content",
    Authority.PROJECT_WRITE,
    "NativeAgentService can_write checks",
    expected_foreign_status=403,
)
_action(
    "native_agent_credential",
    "manage",
    Authority.USER_PRIVATE,
    "NativeAgentService credential routes scope list/create by user_id and id routes by credential_id + user_id",
)
_action(
    "native_agent_skill_install",
    "read",
    Authority.PROJECT_READ,
    "NativeAgentService.get_agent filters NativeAgent.project_id == project.id "
    "NativeAgent.owner_user_id == user.id + NativeAgentSkillInstall.agent_id == agent_id "
    "NativeAgentSkillInstall.project_id == project.id NativeAgentSkillInstall.user_id == user.id",
)
_action(
    "native_agent_skill_install",
    "manage",
    Authority.PROJECT_WRITE,
    "require_write_access + NativeAgentService.get_agent filters NativeAgent.project_id == project.id "
    "NativeAgent.owner_user_id == user.id + NativeAgentSkillInstall.agent_id == agent_id "
    "NativeAgentSkillInstall.project_id == project.id NativeAgentSkillInstall.user_id == user.id writes",
    expected_foreign_status=403,
)
_action("native_mcp_server", "manage", Authority.USER_PRIVATE, "NativeAgentService MCP user_id checks")
_action(
    "skill",
    "manage",
    Authority.USER_PRIVATE,
    "NativeAgentService skill visibility/project membership, owner_user_id edit, and per-user hide scope",
)
_action("local_agent_host_package", "read", Authority.USER_PRIVATE, "get_current_user + package builder")
_action("mcp_catalog", "read", Authority.USER_PRIVATE, "get_current_user + McpCatalogService")
_action("mcp_catalog", "probe", Authority.USER_PRIVATE, "get_current_user + McpCatalogService probe")
_action("official_badge_ui", "read", Authority.USER_PRIVATE, "get_current_user + runtime override")
_action(
    "official_badge_ui",
    "admin",
    Authority.SITE_ADMIN,
    "require_admin + runtime override",
    expected_foreign_status=403,
)
_action("dataset_project", "read", Authority.PROJECT_READ, "get_current_project + DatasetService")
_action(
    "dataset_project",
    "write_content",
    Authority.PROJECT_WRITE,
    "require_write_access + DatasetService",
)
_action("dataset_source_rule", "read", Authority.PROJECT_READ, "get_current_project + DatasetService")
_action(
    "dataset_source_rule",
    "write_content",
    Authority.PROJECT_WRITE,
    "require_write_access + DatasetService",
)
_action(
    "dataset_record",
    "read",
    Authority.PROJECT_READ,
    "DatasetProject.project_id == project.id and DatasetRecord.dataset_project_id == dataset.id",
)
_action(
    "dataset_response",
    "manage",
    Authority.PROJECT_WRITE,
    "require_write_access + DatasetRecord.dataset_project_id == dataset.id + "
    "DatasetResponse.dataset_project_id == record.dataset_project_id + "
    "DatasetResponse.record_id == record.id + DatasetResponse.user_id == user.id",
)
_action(
    "project_archive_binding",
    "manage",
    Authority.PROJECT_OWNER,
    "archives._require_owner",
)
_action("project_archive_binding", "read", Authority.PROJECT_READ, "archives.status")
_action("project_archive_snapshot", "read", Authority.PROJECT_READ, "get_project_from_path")
_action(
    "project_archive_snapshot",
    "write_content",
    Authority.PROJECT_OWNER,
    "major_versions._require_owner",
)
_action(
    "spelling_preference",
    "manage",
    Authority.USER_PRIVATE,
    "SpellingService._get_preference scopes SpellingPreference.user_id to user.id for stored preferences",
)
_action(
    "notification",
    "manage",
    Authority.USER_PRIVATE,
    "Notification.user_id inline select/update gates and notification_id owner check",
)
_action(
    "recent_collaborator",
    "read",
    Authority.USER_PRIVATE,
    "ProjectMemberService.list_recent_collaborators",
)


API_POLICIES: tuple[ApiPolicy, ...] = (
    ApiPolicy("GET", "/api/project/tree", "project", "read", "session", "get_current_project"),
    ApiPolicy(
        "PUT",
        "/api/project/name",
        "project",
        "write_content",
        "session",
        "require_write_access",
    ),
    ApiPolicy(
        "POST",
        "/api/project/import.zip",
        "project",
        "write_content",
        "session",
        "require_write_access",
    ),
    ApiPolicy(
        "GET",
        "/api/projects",
        "project",
        "list",
        "session",
        "ProjectService.list + accepted shared projects",
    ),
    ApiPolicy("POST", "/api/projects", "project", "create", "session", "ProjectService.create"),
    ApiPolicy(
        "POST",
        "/api/projects/import/github",
        "project",
        "create",
        "session",
        "ProjectService.create + GitHubService.import_repo_into_project",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/recent-collaborators",
        "recent_collaborator",
        "read",
        "session",
        "ProjectMemberService.list_recent_collaborators",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}",
        "project",
        "read_owned",
        "session",
        "ProjectService.get user_id owner filter",
    ),
    ApiPolicy(
        "PATCH",
        "/api/projects/{project_id}",
        "project",
        "admin",
        "session",
        "ProjectService.update user_id owner filter + ProjectService._scoped_main_doc_id main_doc_id project scope",
    ),
    ApiPolicy(
        "DELETE",
        "/api/projects/{project_id}",
        "project",
        "delete",
        "session",
        "ProjectService.delete user_id owner filter",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/events",
        "project",
        "read",
        "session",
        "get_project_from_path",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/online",
        "project",
        "read",
        "session",
        "get_project_from_path",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/export.zip",
        "project",
        "read",
        "session",
        "get_project_from_path",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/annotation-training-export",
        "project",
        "read",
        "session",
        "get_project_from_path + build_annotation_training_export_zip",
    ),
    ApiPolicy(
        "POST",
        "/api/projects/{project_id}/skill-cache",
        "project",
        "refresh_skill_cache",
        "session",
        "ProjectMemberService.can_write accepted owner/editor + NativeAgentService.update_project_skill_cache",
    ),
    ApiPolicy(
        "POST",
        "/api/projects/{project_id}/skill-data/from-dataset",
        "project",
        "write_content",
        "session",
        "ProjectMemberService.can_write accepted editor + ProjectMemberService.has_access data_project_id source project scope",
    ),
    ApiPolicy(
        "DELETE",
        "/api/projects/{project_id}/skill-data",
        "project",
        "write_content",
        "session",
        "ProjectMemberService.can_write accepted editor + optional ProjectMemberService.has_access data_project_id source project scope",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/members",
        "project_member",
        "read",
        "session",
        "get_project_from_path accepted member + ProjectMemberService.list_members accepted roster; owner sees inactive invites",
    ),
    ApiPolicy(
        "POST",
        "/api/projects/{project_id}/members",
        "project_member",
        "manage",
        "session",
        "ProjectMemberService.get_role accepted owner + ProjectMemberService.add_member",
    ),
    ApiPolicy(
        "DELETE",
        "/api/projects/{project_id}/members/{user_id}",
        "project_member",
        "manage",
        "session",
        "ProjectMemberService.get_role accepted owner + ProjectMemberService.remove_member",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/archive/status",
        "project_archive_binding",
        "read",
        "session",
        "get_project_from_path + ProjectArchiveService.status",
    ),
    ApiPolicy(
        "PUT",
        "/api/projects/{project_id}/archive/github",
        "project_archive_binding",
        "manage",
        "session",
        "archives._require_owner + ProjectArchiveService.configure_github",
    ),
    ApiPolicy(
        "POST",
        "/api/projects/{project_id}/archive/github/import",
        "project_archive_snapshot",
        "write_content",
        "session",
        "archives._require_owner + GitHubService.import_repo_into_project",
    ),
    ApiPolicy(
        "POST",
        "/api/projects/{project_id}/archive/github/push",
        "project_archive_snapshot",
        "write_content",
        "session",
        "archives._require_owner + ProjectArchiveService.push_to_github",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/archive/snapshots",
        "project_archive_snapshot",
        "read",
        "session",
        "get_project_from_path + ProjectArchiveService.list_snapshots",
    ),
    ApiPolicy(
        "POST",
        "/api/projects/{project_id}/archive/snapshots",
        "project_archive_snapshot",
        "write_content",
        "session",
        "archives._require_owner + ProjectArchiveService.create_snapshot",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/major-versions",
        "project_archive_snapshot",
        "read",
        "session",
        "get_project_from_path + ProjectArchiveService.list_commits",
    ),
    ApiPolicy(
        "POST",
        "/api/projects/{project_id}/major-versions",
        "project_archive_snapshot",
        "write_content",
        "session",
        "major_versions._require_owner + ProjectArchiveService.create_snapshot",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/major-versions/{sha}",
        "project_archive_snapshot",
        "read",
        "session",
        "get_project_from_path + ProjectArchiveService.list_commit_files",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/major-versions/{sha}/download",
        "project_archive_snapshot",
        "read",
        "session",
        "get_project_from_path + ProjectArchiveService.archive_commit_zip",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/major-versions/{sha}/diff",
        "project_archive_snapshot",
        "read",
        "session",
        "get_project_from_path + ProjectArchiveService.get_commit_diff",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/major-versions/{sha}/files/{path:path}",
        "project_archive_snapshot",
        "read",
        "session",
        "get_project_from_path + ProjectArchiveService.read_commit_file",
    ),
    ApiPolicy(
        "POST",
        "/api/projects/{project_id}/major-versions/{sha}/restore",
        "project_archive_snapshot",
        "write_content",
        "session",
        "major_versions._require_owner + ProjectArchiveService.restore_to_commit",
    ),
    ApiPolicy(
        "POST",
        "/api/folders",
        "folder",
        "write_content",
        "session",
        "require_write_access + ProjectFsService._get_folder_in_project parent_folder_id project scope",
    ),
    ApiPolicy(
        "POST",
        "/api/docs",
        "doc",
        "write_content",
        "session",
        "require_write_access + ProjectFsService._get_folder_in_project folder_id project scope",
    ),
    ApiPolicy("GET", "/api/docs/{doc_id}", "doc", "read", "session", "get_current_project"),
    ApiPolicy(
        "GET",
        "/api/internal/docs/{doc_id}/content",
        "doc",
        "read",
        "session-or-collab-token",
        "get_optional_current_user or AuthService.verify_collab_token + ProjectMemberService.has_access accepted members",
    ),
    ApiPolicy(
        "PUT",
        "/api/docs/{doc_id}",
        "doc",
        "write_content",
        "session",
        "require_write_access",
    ),
    ApiPolicy(
        "POST",
        "/api/docs/{doc_id}/collab-flush",
        "doc",
        "write_content",
        "session",
        "require_write_access + collab_snapshot_service.snapshot_doc_from_collab",
    ),
    ApiPolicy(
        "POST",
        "/api/entities/{entity_type}/{entity_id}/rename",
        "project",
        "write_content",
        "session",
        "require_write_access + ProjectFsService.rename_entity_with_format",
    ),
    ApiPolicy(
        "DELETE",
        "/api/entities/{entity_type}/{entity_id}",
        "project",
        "write_content",
        "session",
        "require_write_access + ProjectFsService.delete_entity",
    ),
    ApiPolicy(
        "POST",
        "/api/entities/{entity_type}/{entity_id}/move",
        "project",
        "write_content",
        "session",
        "require_write_access + ProjectFsService.move_entity entity_id project scope + target_folder_id project scope",
    ),
    ApiPolicy(
        "GET", "/api/files/{file_id}", "file_blob", "read", "session", "ProjectMemberService.has_access accepted members"
    ),
    ApiPolicy(
        "POST",
        "/api/files/upload",
        "file_blob",
        "write_content",
        "session",
        "require_write_access + ProjectFsService._get_folder_in_project folder_id project scope",
    ),
    ApiPolicy(
        "POST",
        "/api/files/{file_id}/convert-to-doc",
        "file_blob",
        "write_content",
        "session",
        "require_write_access",
    ),
    ApiPolicy(
        "GET",
        "/api/auth/collab-token",
        "doc",
        "issue_collab_token",
        "session",
        "ProjectMemberService.can_write accepted editors",
        expected_foreign_status=404,
        notes=(
            "Route hides foreign doc ids with 404; action also models "
            "collab-token verify/read-only 403 cases."
        ),
    ),
    ApiPolicy(
        "GET",
        "/api/auth/verify",
        "doc",
        "issue_collab_token",
        "collab-token",
        "ProjectMemberService.can_write accepted editors",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "POST",
        "/api/compile",
        "project",
        "compile",
        "session",
        "require_write_access + _validate_main_doc_id main_doc_id project scope",
    ),
    ApiPolicy(
        "DELETE",
        "/api/compile/cache",
        "project",
        "compile",
        "session",
        "require_write_access + compiler clear project cache",
    ),
    ApiPolicy(
        "POST",
        "/api/compile/sync-to-pdf",
        "project",
        "compile_read",
        "session",
        "get_current_project + _ensure_project_doc document_id project scope + compiler sync_to_pdf",
    ),
    ApiPolicy(
        "POST",
        "/api/compile/sync-from-pdf",
        "project",
        "compile_read",
        "session",
        "get_current_project + compiler sync_from_pdf",
    ),
    ApiPolicy(
        "GET",
        "/api/compile/log",
        "project",
        "compile_read",
        "session",
        "get_current_project + compiler cached log",
    ),
    ApiPolicy(
        "GET",
        "/api/compile/settings",
        "project",
        "compile_read",
        "session",
        "get_current_project",
    ),
    ApiPolicy(
        "PUT",
        "/api/compile/settings",
        "project",
        "compile",
        "session",
        "require_write_access + _validate_main_doc_id main_doc_id project scope + incremental_compile project setting",
    ),
    ApiPolicy(
        "GET",
        "/api/projects/{project_id}/compile.pdf",
        "project",
        "compile_read",
        "session",
        "get_project_from_path + compiler cached pdf",
    ),
    ApiPolicy(
        "GET",
        "/api/docs/{doc_id}/versions",
        "document_version",
        "read",
        "session",
        "get_current_project + _get_doc_or_404",
    ),
    ApiPolicy(
        "GET",
        "/api/docs/{doc_id}/versions/{version}",
        "document_version",
        "read",
        "session",
        "get_current_project + _ensure_doc",
    ),
    ApiPolicy(
        "GET",
        "/api/docs/{doc_id}/diff",
        "document_version",
        "read",
        "session",
        "get_current_project + _ensure_doc",
    ),
    ApiPolicy(
        "POST",
        "/api/docs/{doc_id}/restore/{version}",
        "document_version",
        "restore",
        "session",
        "require_write_access",
    ),
    ApiPolicy(
        "POST",
        "/api/docs/{doc_id}/labels",
        "document_label",
        "write_content",
        "session",
        "require_write_access",
    ),
    ApiPolicy(
        "DELETE",
        "/api/docs/{doc_id}/labels/{label_id}",
        "document_label",
        "write_content",
        "session",
        "require_write_access",
    ),
    ApiPolicy(
        "GET",
        "/api/docs/{doc_id}/operations",
        "operation",
        "read",
        "session",
        "get_current_project + _ensure_doc",
    ),
    ApiPolicy(
        "POST",
        "/api/docs/{doc_id}/operations",
        "operation",
        "write_content",
        "session",
        "require_write_access",
    ),
    ApiPolicy(
        "GET",
        "/api/mcp/whoami",
        "mcp_token",
        "manage",
        "mcp-token",
        "mcp_whoami -> get_mcp_auth -> McpTokenService.verify_token loads McpToken.user_id",
    ),
    ApiPolicy(
        "GET",
        "/api/mcp/projects",
        "project",
        "read",
        "mcp-token",
        "AgentCommand superleaf_list_projects",
    ),
    ApiPolicy(
        "GET",
        "/api/mcp/projects/{project_id}/docs",
        "doc",
        "read",
        "mcp-token",
        "AgentCommand project_from_args",
    ),
    ApiPolicy(
        "GET",
        "/api/mcp/projects/{project_id}/docs/{doc_id}",
        "doc",
        "read",
        "mcp-token",
        "AgentCommand require_doc",
    ),
    ApiPolicy(
        "GET", "/api/mcp/projects/{project_id}/grep", "doc", "read", "mcp-token", "AgentCommand project_grep"
    ),
    ApiPolicy(
        "GET",
        "/api/mcp/projects/{project_id}/docs/{doc_id}/outline",
        "doc",
        "read",
        "mcp-token",
        "AgentCommand outline",
    ),
    ApiPolicy(
        "GET",
        "/api/mcp/tokens",
        "mcp_token",
        "manage",
        "session",
        "list_mcp_tokens -> McpTokenService.list_tokens McpToken.user_id == user.id revoked_at",
    ),
    ApiPolicy(
        "POST",
        "/api/mcp/tokens",
        "mcp_token",
        "manage",
        "session",
        "create_mcp_token -> McpTokenService.create_token McpToken.user_id == user.id revoked_at",
    ),
    ApiPolicy(
        "DELETE",
        "/api/mcp/tokens/{token_id}",
        "mcp_token",
        "manage",
        "session",
        "revoke_mcp_token token_id -> McpTokenService.revoke_token rejects McpToken.user_id != user.id",
    ),
    ApiPolicy("GET", "/api/health", "health", "read", "public", "health"),
    ApiPolicy("POST", "/api/auth/register", "user", "register", "public", "AuthService.register"),
    ApiPolicy("POST", "/api/auth/login", "session", "create", "public", "AuthService.authenticate"),
    ApiPolicy("POST", "/api/auth/logout", "session", "destroy", "public", "AuthService.logout"),
    ApiPolicy("GET", "/api/auth/me", "session", "read", "session", "get_current_user"),
    ApiPolicy(
        "GET",
        "/api/users",
        "user",
        "admin",
        "session",
        "require_admin + UserService",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "GET",
        "/api/users/invites/email-status",
        "registration_invite",
        "manage",
        "session",
        "require_admin + RegistrationInviteService",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "GET",
        "/api/users/invites",
        "registration_invite",
        "manage",
        "session",
        "require_admin + RegistrationInviteService",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "POST",
        "/api/users/invites",
        "registration_invite",
        "manage",
        "session",
        "require_admin + RegistrationInviteService",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "POST",
        "/api/users/invites/{invite_id}/resend",
        "registration_invite",
        "manage",
        "session",
        "require_admin + RegistrationInviteService",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "DELETE",
        "/api/users/invites/{invite_id}",
        "registration_invite",
        "manage",
        "session",
        "require_admin + RegistrationInviteService",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "PATCH",
        "/api/users/{user_id}",
        "user",
        "admin",
        "session",
        "require_admin + UserService",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "DELETE",
        "/api/users/{user_id}",
        "user",
        "admin",
        "session",
        "require_admin + UserService",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "GET",
        "/api/providers",
        "provider",
        "manage",
        "session",
        "ProviderService.list_providers Provider.user_id user_id filter",
    ),
    ApiPolicy(
        "POST",
        "/api/providers",
        "provider",
        "manage",
        "session",
        "ProviderService.create user_id Provider.user_id owner assignment",
    ),
    ApiPolicy(
        "PATCH",
        "/api/providers/{provider_id}",
        "provider",
        "manage",
        "session",
        "provider_id + ProviderService.update + ProviderService.get Provider.user_id user_id owner",
    ),
    ApiPolicy(
        "DELETE",
        "/api/providers/{provider_id}",
        "provider",
        "manage",
        "session",
        "provider_id + ProviderService.delete + ProviderService.get Provider.user_id user_id owner",
    ),
    ApiPolicy(
        "POST",
        "/api/providers/{provider_id}/activate",
        "provider",
        "manage",
        "session",
        "provider_id + ProviderService.activate + ProviderService.get Provider.user_id user_id owner + "
        "ProviderService._set_active user_id",
    ),
    ApiPolicy(
        "POST",
        "/api/providers/{provider_id}/probe",
        "provider",
        "manage",
        "session",
        "provider_id + ProviderService.probe + ProviderService.get Provider.user_id user_id owner",
    ),
    ApiPolicy(
        "GET",
        "/api/providers/{provider_id}/models",
        "provider",
        "manage",
        "session",
        "provider_id + ProviderService.list_models + ProviderService.get Provider.user_id user_id owner",
    ),
    ApiPolicy(
        "POST",
        "/api/providers/{provider_id}/browser-nanobot-models",
        "provider",
        "manage",
        "session",
        "provider_id + ProviderService.sync_browser_nanobot_models + ProviderService.get Provider.user_id user_id owner",
    ),
    ApiPolicy(
        "POST",
        "/api/providers/{provider_id}/browser-codex-agent",
        "provider",
        "manage",
        "session",
        "provider_id + ProviderService.sync_browser_codex_agent + ProviderService.get Provider.user_id user_id owner",
    ),
    ApiPolicy(
        "POST",
        "/api/providers/{provider_id}/browser-claude-agent",
        "provider",
        "manage",
        "session",
        "provider_id + ProviderService.sync_browser_claude_agent + ProviderService.get Provider.user_id user_id owner",
    ),
    ApiPolicy(
        "GET",
        "/api/providers/{provider_id}/stats",
        "provider",
        "manage",
        "session",
        "provider_id + ProviderService.get Provider.user_id user_id owner + "
        "stats_service.stats_for_provider CachedWorkflow.user_id user_id aggregates",
    ),
    ApiPolicy(
        "POST",
        "/api/spelling/check",
        "spelling_preference",
        "manage",
        "session",
        "check_spelling -> SpellingService.check_words -> SpellingService.learned_words -> "
        "SpellingService._get_preference SpellingPreference.user_id == user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/spelling/suggest",
        "spelling_preference",
        "manage",
        "session",
        "suggest_spelling requires get_current_user; SpellingService.suggestions is stateless",
    ),
    ApiPolicy(
        "GET",
        "/api/spelling/dictionary",
        "spelling_preference",
        "manage",
        "session",
        "spelling_dictionary -> SpellingService.learned_words_list -> "
        "SpellingService._get_preference SpellingPreference.user_id == user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/spelling/learn",
        "spelling_preference",
        "manage",
        "session",
        "learn_spelling_word -> SpellingService.learn_word -> "
        "SpellingService._get_preference SpellingPreference.user_id == user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/spelling/unlearn",
        "spelling_preference",
        "manage",
        "session",
        "unlearn_spelling_word -> SpellingService.unlearn_word -> "
        "SpellingService._get_preference SpellingPreference.user_id == user.id",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/ui/official-badge",
        "official_badge_ui",
        "read",
        "session",
        "get_current_user + runtime override",
    ),
    ApiPolicy(
        "PATCH",
        "/api/native-agent/ui/official-badge",
        "official_badge_ui",
        "admin",
        "session",
        "require_admin + runtime override",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/mcp/catalog",
        "mcp_catalog",
        "read",
        "session",
        "get_current_user + McpCatalogService",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/mcp/policy",
        "mcp_catalog",
        "read",
        "session",
        "get_current_user + McpCatalogService",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/mcp/probe",
        "mcp_catalog",
        "probe",
        "session",
        "get_current_user + McpCatalogService probe/golden_test",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/mcp/golden-test",
        "mcp_catalog",
        "probe",
        "session",
        "get_current_user + McpCatalogService probe/golden_test",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/mcp/servers",
        "native_mcp_server",
        "manage",
        "session",
        "McpConfigService.list_servers user_id filter",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/mcp/servers",
        "native_mcp_server",
        "manage",
        "session",
        "McpConfigService.ensure_preset_server or McpConfigService.create_custom_server user_id owner",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/mcp/servers/from-preset/{preset_id}",
        "native_mcp_server",
        "manage",
        "session",
        "McpConfigService.ensure_preset_server preset_id + user_id owner",
    ),
    ApiPolicy(
        "PATCH",
        "/api/native-agent/mcp/servers/{server_id}",
        "native_mcp_server",
        "manage",
        "session",
        "McpConfigService.update_server server_id + user_id owner",
    ),
    ApiPolicy(
        "DELETE",
        "/api/native-agent/mcp/servers/{server_id}",
        "native_mcp_server",
        "manage",
        "session",
        "McpConfigService.delete_server server_id + user_id owner",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/mcp/servers/{server_id}/probe",
        "native_mcp_server",
        "manage",
        "session",
        "McpConfigService.get_server server_id + user_id owner before probe + "
        "McpConfigService.mark_probe user_id owner",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/mcp/servers/{server_id}/golden-test",
        "native_mcp_server",
        "manage",
        "session",
        "McpConfigService.get_server server_id + user_id owner before golden-test + "
        "McpConfigService.mark_golden user_id owner",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/credentials",
        "native_agent_credential",
        "manage",
        "session",
        "NativeAgentService.list_credentials user_id filter",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/credentials",
        "native_agent_credential",
        "manage",
        "session",
        "NativeAgentService.create_credential user_id owner assignment",
    ),
    ApiPolicy(
        "PATCH",
        "/api/native-agent/credentials/{credential_id}",
        "native_agent_credential",
        "manage",
        "session",
        "credential_id + NativeAgentService.update_credential + NativeAgentService.get_credential user_id owner",
    ),
    ApiPolicy(
        "DELETE",
        "/api/native-agent/credentials/{credential_id}",
        "native_agent_credential",
        "manage",
        "session",
        "credential_id + NativeAgentService.delete_credential + NativeAgentService.get_credential user_id owner",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/credentials/{credential_id}/probe",
        "native_agent_credential",
        "manage",
        "session",
        "credential_id + NativeAgentService.mark_credential_probe + NativeAgentService.get_credential user_id owner",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/skills",
        "skill",
        "manage",
        "session",
        "NativeAgentService.list_skills user_id visibility owner_user_id/project "
        "ProjectMemberService.has_access + SkillHidden",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/skills",
        "skill",
        "manage",
        "session",
        "NativeAgentService.create_skill user_id owner_user_id assignment + owner_user_id public_name uniqueness",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/skills/recipe",
        "skill",
        "manage",
        "session",
        "NativeAgentService.create_recipe_skill user_id owner_user_id assignment + owner_user_id public_name uniqueness",
    ),
    ApiPolicy(
        "PATCH",
        "/api/native-agent/skills/{skill_id}",
        "skill",
        "manage",
        "session",
        "skill_id + NativeAgentService.update_skill + NativeAgentService.can_edit_skill owner_user_id user_id",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/skills/{skill_id}/publish",
        "skill",
        "manage",
        "session",
        "skill_id + NativeAgentService.publish_skill + NativeAgentService.can_edit_skill owner_user_id user_id",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/skills/{skill_id}/unpublish",
        "skill",
        "manage",
        "session",
        "skill_id + NativeAgentService.unpublish_skill + NativeAgentService.can_edit_skill owner_user_id user_id",
    ),
    ApiPolicy(
        "DELETE",
        "/api/native-agent/skills/{skill_id}",
        "skill",
        "manage",
        "session",
        "skill_id + NativeAgentService.delete_skill + NativeAgentService.get_skill user_id visibility + "
        "owner delete or NativeAgentService._hide_skill per user_id",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/local-agent-host/package",
        "local_agent_host_package",
        "read",
        "session",
        "get_current_user + local package builder",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/local-agent-host/update",
        "local_agent_host_package",
        "read",
        "session",
        "get_current_user + local package builder",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/local-agent-host/download",
        "local_agent_host_package",
        "read",
        "session",
        "get_current_user + local package builder",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/skills/{skill_id}/download",
        "skill",
        "manage",
        "session",
        "skill_id + NativeAgentService.get_skill user_id visibility/project membership",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/skills/{skill_id}/usage",
        "skill",
        "manage",
        "session",
        "skill_id + NativeAgentService.get_skill user_id visibility + NativeAgentService.agents_using_skill user_id owner scope",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/skill-marketplace",
        "skill",
        "manage",
        "session",
        "SkillMarketplaceService.list_entries user_id + SkillMarketplaceService._installed_by_catalog_id "
        "owner_user_id marketplace_id annotations",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/skill-marketplace/{skill_id}/install",
        "skill",
        "manage",
        "session",
        "catalog skill_id + SkillMarketplaceService.install + SkillMarketplaceService._find_entry user_id + "
        "SkillMarketplaceService._installed_by_catalog_id owner_user_id current-user upsert",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/skill-marketplace/{skill_id}/update",
        "skill",
        "manage",
        "session",
        "catalog skill_id update delegates SkillMarketplaceService.install + "
        "SkillMarketplaceService._installed_by_catalog_id owner_user_id user_id",
    ),
    ApiPolicy(
        "DELETE",
        "/api/native-agent/skill-marketplace/{skill_id}/uninstall",
        "skill",
        "manage",
        "session",
        "catalog skill_id + SkillMarketplaceService.uninstall + "
        "SkillMarketplaceService._installed_by_catalog_id owner_user_id user_id",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/skill-marketplace/{skill_id}/clone-to-local",
        "skill",
        "manage",
        "session",
        "catalog skill_id + SkillMarketplaceService.clone_to_local + "
        "SkillMarketplaceService._installed_by_catalog_id user_id owner install + ProjectService.create user_id + "
        "NativeAgentService.update_project_skill_cache + SkillMarketplaceService.uninstall user_id",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/agents",
        "native_agent",
        "read",
        "session",
        "NativeAgentService project membership checks",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/agents",
        "native_agent",
        "write_content",
        "session",
        "require_write_access + NativeAgentService provider/skill user filters",
        expected_foreign_status=404,
        notes="Foreign project header is hidden with 404; action also models read-only member 403 cases.",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/agents/{agent_id}/skills",
        "native_agent_skill_install",
        "read",
        "session",
        "list_agent_skill_installs get_current_project + NativeAgentService.get_agent "
        "agent_id filters NativeAgent.project_id == project.id NativeAgent.owner_user_id == user.id + "
        "NativeAgentService.list_agent_skill_installs filters NativeAgentSkillInstall.agent_id == "
        "agent_id NativeAgentSkillInstall.project_id == project.id NativeAgentSkillInstall.user_id == user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/native-agent/agents/{agent_id}/skills/install-npx",
        "native_agent_skill_install",
        "manage",
        "session",
        "install_agent_skill_recipe require_write_access + NativeAgentService.get_agent "
        "agent_id filters NativeAgent.project_id == project.id NativeAgent.owner_user_id == user.id + "
        "_ensure_npx_skill_install_allowed + NativeAgentService.install_agent_skill_recipe -> "
        "_install_skill_recipes creates NativeAgentSkillInstall.agent_id == agent.id "
        "NativeAgentSkillInstall.project_id == project.id NativeAgentSkillInstall.user_id == user.id",
        expected_foreign_status=404,
        notes="Foreign agent ids are hidden with 404; action also models read-only member 403 cases.",
    ),
    ApiPolicy(
        "GET",
        "/api/native-agent/agents/{agent_id}/workspace/tree",
        "native_agent",
        "read",
        "session",
        "NativeAgentService project membership checks",
    ),
    ApiPolicy(
        "PATCH",
        "/api/native-agent/agents/{agent_id}",
        "native_agent",
        "write_content",
        "session",
        "require_write_access + NativeAgentService provider/skill user filters",
        expected_foreign_status=404,
        notes="Foreign agent ids are hidden with 404; action also models read-only member 403 cases.",
    ),
    ApiPolicy(
        "DELETE",
        "/api/native-agent/agents/{agent_id}",
        "native_agent",
        "write_content",
        "session",
        "require_write_access + NativeAgentService project/user filters",
        expected_foreign_status=404,
        notes="Foreign agent ids are hidden with 404; action also models read-only member 403 cases.",
    ),
    ApiPolicy(
        "GET",
        "/api/workflows",
        "cached_workflow",
        "manage",
        "session",
        "list_workflows filters CachedWorkflow.user_id == user.id and NativeAgent.owner_user_id == user.id "
        "NativeAgent.project_id == project.id Provider.user_id == user.id",
    ),
    ApiPolicy(
        "GET",
        "/api/workflows/runs",
        "workflow_run",
        "read",
        "session",
        "list_runs filters WorkflowRun.project_id == project.id WorkflowRun.user_id == user.id "
        "then optional document_id workflow_id",
    ),
    ApiPolicy(
        "GET",
        "/api/workflows/runs/{run_id}",
        "workflow_run",
        "read",
        "session",
        "get_run run_id rejects if WorkflowRun.project_id != project.id or WorkflowRun.user_id != user.id",
    ),
    ApiPolicy(
        "DELETE",
        "/api/workflows/runs/{run_id}",
        "workflow_run",
        "manage",
        "session",
        "delete_run run_id rejects if WorkflowRun.project_id != project.id or WorkflowRun.user_id != user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/workflows/{workflow_id}/disable",
        "cached_workflow",
        "manage",
        "session",
        "disable_workflow workflow_id checks CachedWorkflow.user_id == user.id or "
        "AgentRegistryService.resolve NativeAgent.owner_user_id NativeAgent.project_id Provider.user_id",
    ),
    ApiPolicy(
        "POST",
        "/api/workflows/{workflow_id}/enable",
        "cached_workflow",
        "manage",
        "session",
        "enable_workflow workflow_id checks CachedWorkflow.user_id == user.id or "
        "AgentRegistryService.resolve NativeAgent.owner_user_id NativeAgent.project_id Provider.user_id",
    ),
    ApiPolicy(
        "POST",
        "/api/workflows/{workflow_id}/run",
        "cached_workflow",
        "manage",
        "session",
        "run_workflow workflow_id checks CachedWorkflow.user_id == user.id ProviderService.get Provider.user_id "
        "or AgentRegistryService.resolve NativeAgent.owner_user_id NativeAgent.project_id Provider.user_id + "
        "_ensure_run_document document_id project.id + "
        "_ensure_context_files_in_project context_files[].document_id project.id",
    ),
    ApiPolicy(
        "GET",
        "/api/workflows/definitions",
        "workflow_definition",
        "manage",
        "session",
        "list_workflow_definitions filters WorkflowDefinition.is_active "
        "WorkflowDefinition.project_id == project.id WorkflowDefinition.user_id == user.id",
    ),
    ApiPolicy(
        "GET",
        "/api/workflows/definitions/{definition_id}",
        "workflow_definition",
        "manage",
        "session",
        "get_workflow_definition definition_id rejects if WorkflowDefinition.project_id != project.id "
        "or WorkflowDefinition.user_id != user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/workflows/definitions",
        "workflow_definition",
        "manage",
        "session",
        "create_workflow_definition creates WorkflowDefinition.project_id == project.id "
        "WorkflowDefinition.user_id == user.id",
    ),
    ApiPolicy(
        "PUT",
        "/api/workflows/definitions/{definition_id}",
        "workflow_definition",
        "manage",
        "session",
        "update_workflow_definition definition_id rejects if WorkflowDefinition.project_id != project.id "
        "or WorkflowDefinition.user_id != user.id",
    ),
    ApiPolicy(
        "DELETE",
        "/api/workflows/definitions/{definition_id}",
        "workflow_definition",
        "manage",
        "session",
        "delete_workflow_definition definition_id rejects if WorkflowDefinition.project_id != project.id "
        "or WorkflowDefinition.user_id != user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/workflows/definitions/{definition_id}/execute",
        "workflow_definition",
        "manage",
        "session",
        "execute_workflow_definition definition_id checks WorkflowDefinition.project_id == project.id "
        "WorkflowDefinition.user_id == user.id + _collect_unhealthy_agents "
        "AgentRegistryService.resolve + _ensure_run_document document_id project.id + "
        "_ensure_context_files_in_project context_files[].document_id project.id",
    ),
    ApiPolicy(
        "GET",
        "/api/workflows/definitions/{definition_id}/test-cases",
        "workflow_test_case",
        "manage",
        "session",
        "list_cases _require_definition definition_id checks WorkflowDefinition.project_id == project.id "
        "WorkflowDefinition.user_id == user.id; filters WorkflowTestCase.definition_id == definition_id",
    ),
    ApiPolicy(
        "POST",
        "/api/workflows/definitions/{definition_id}/test-cases",
        "workflow_test_case",
        "manage",
        "session",
        "create_case _require_definition definition_id checks WorkflowDefinition.project_id == project.id "
        "WorkflowDefinition.user_id == user.id; creates WorkflowTestCase.definition_id == definition_id",
    ),
    ApiPolicy(
        "PUT",
        "/api/workflows/definitions/{definition_id}/test-cases/{case_id}",
        "workflow_test_case",
        "manage",
        "session",
        "update_case _require_definition definition_id checks WorkflowDefinition.project_id == project.id "
        "WorkflowDefinition.user_id == user.id; case_id rejects if "
        "WorkflowTestCase.definition_id != definition_id",
    ),
    ApiPolicy(
        "DELETE",
        "/api/workflows/definitions/{definition_id}/test-cases/{case_id}",
        "workflow_test_case",
        "manage",
        "session",
        "delete_case _require_definition definition_id checks WorkflowDefinition.project_id == project.id "
        "WorkflowDefinition.user_id == user.id; case_id rejects if "
        "WorkflowTestCase.definition_id != definition_id",
    ),
    ApiPolicy(
        "GET",
        "/api/github/account",
        "github_account",
        "manage",
        "session",
        "GitHubService.account GitHubAccount.user_id == user.id",
    ),
    ApiPolicy(
        "DELETE",
        "/api/github/account",
        "github_account",
        "manage",
        "session",
        "GitHubService.disconnect + GitHubService.account GitHubAccount.user_id == user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/github/token",
        "github_account",
        "manage",
        "session",
        "GitHubService.connect_token + GitHubService.account GitHubAccount.user_id == user.id upsert",
    ),
    ApiPolicy(
        "POST",
        "/api/github/oauth/start",
        "github_account",
        "manage",
        "session",
        "GitHubService.begin_oauth creates state with GitHubOAuthState.user_id == user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/github/device/start",
        "github_account",
        "manage",
        "session",
        "get_current_user + GitHubService.begin_device_flow external GitHub device request",
    ),
    ApiPolicy(
        "POST",
        "/api/github/device/poll",
        "github_account",
        "manage",
        "session",
        "GitHubService.poll_device_flow + GitHubService.connect_token GitHubAccount.user_id == user.id",
    ),
    ApiPolicy(
        "GET",
        "/api/github/oauth/callback",
        "github_account",
        "manage",
        "session",
        "state + GitHubService.complete_oauth verifies GitHubOAuthState.user_id == user.id then "
        "GitHubService.connect_token",
    ),
    ApiPolicy(
        "GET",
        "/api/conversations",
        "conversation",
        "manage",
        "session",
        "list_conversations filters Conversation.project_id == project.id Conversation.user_id == user.id "
        "before optional document_id workflow_id filters",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations",
        "conversation",
        "manage",
        "session",
        "create_conversation _resolve_agent workflow_id project.id user.id + "
        "_ensure_conversation_document document_id Doc.project_id == project.id; "
        "creates Conversation.project_id == project.id Conversation.user_id == user.id",
    ),
    ApiPolicy(
        "GET",
        "/api/conversations/{conversation_id}",
        "conversation",
        "manage",
        "session",
        "get_conversation conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id",
    ),
    ApiPolicy(
        "PATCH",
        "/api/conversations/{conversation_id}",
        "conversation",
        "manage",
        "session",
        "update_conversation conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id",
    ),
    ApiPolicy(
        "DELETE",
        "/api/conversations/{conversation_id}",
        "conversation",
        "manage",
        "session",
        "delete_conversation conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id; deletes Message.conversation_id == conversation_id",
    ),
    ApiPolicy(
        "GET",
        "/api/conversations/{conversation_id}/messages",
        "message",
        "manage",
        "session",
        "list_messages conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id; filters Message.conversation_id == conversation_id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/messages",
        "message",
        "manage",
        "session",
        "send_message conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id; creates Message.conversation_id == conversation_id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/browser-codex/prepare",
        "message",
        "manage",
        "session",
        "prepare_browser_codex_message conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id; creates Message.conversation_id == conversation_id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/browser-codex/tool",
        "message",
        "manage",
        "session",
        "execute_browser_codex_tool conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id + _browser_tool_active_document_id "
        "body.document_id Doc.project_id == project.id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/browser-codex/finish",
        "message",
        "manage",
        "session",
        "finish_browser_codex_message conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id; creates Message.conversation_id == conversation_id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/browser-claude/prepare",
        "message",
        "manage",
        "session",
        "prepare_browser_claude_message conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id; creates Message.conversation_id == conversation_id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/browser-claude/tool",
        "message",
        "manage",
        "session",
        "execute_browser_claude_tool conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id + _browser_tool_active_document_id "
        "body.document_id Doc.project_id == project.id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/browser-claude/finish",
        "message",
        "manage",
        "session",
        "finish_browser_claude_message conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id; creates Message.conversation_id == conversation_id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/browser-nanobot/prepare",
        "message",
        "manage",
        "session",
        "prepare_browser_nanobot_message conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id; creates Message.conversation_id == conversation_id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/browser-nanobot/tool",
        "message",
        "manage",
        "session",
        "execute_browser_nanobot_tool conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id + _browser_tool_active_document_id "
        "body.document_id Doc.project_id == project.id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/browser-nanobot/finish",
        "message",
        "manage",
        "session",
        "finish_browser_nanobot_message conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id; creates Message.conversation_id == conversation_id",
    ),
    ApiPolicy(
        "POST",
        "/api/conversations/{conversation_id}/messages/inject",
        "message",
        "manage",
        "session",
        "inject_message conversation_id rejects if Conversation.project_id != project.id "
        "or Conversation.user_id != user.id; creates Message.conversation_id == conversation_id",
    ),
    ApiPolicy(
        "GET",
        "/api/datasets/current",
        "dataset_project",
        "read",
        "session",
        "get_current_project + DatasetService",
    ),
    ApiPolicy(
        "PATCH",
        "/api/datasets/current",
        "dataset_project",
        "write_content",
        "session",
        "require_write_access + DatasetService.update_dataset_project",
    ),
    ApiPolicy(
        "GET",
        "/api/datasets/current/filter-options",
        "dataset_project",
        "read",
        "session",
        "list_current_filter_options _dataset_for_project + DatasetService.source_filter_options "
        "source_project_id DatasetService._require_source_access -> "
        "ProjectMemberService.has_access(source_project_id, user.id)",
    ),
    ApiPolicy(
        "GET",
        "/api/datasets/current/source-rules",
        "dataset_source_rule",
        "read",
        "session",
        "get_current_project + DatasetService",
    ),
    ApiPolicy(
        "POST",
        "/api/datasets/current/source-rules",
        "dataset_source_rule",
        "write_content",
        "session",
        "create_current_source_rule require_write_access + _dataset_for_project + "
        "DatasetService.create_source_rule source_project_id "
        "DatasetService._require_source_access -> ProjectMemberService.has_access(source_project_id, user.id); "
        "creates DatasetSourceRule.dataset_project_id == dataset.id DatasetSourceRule.user_id == user.id",
    ),
    ApiPolicy(
        "PATCH",
        "/api/datasets/source-rules/{rule_id}",
        "dataset_source_rule",
        "write_content",
        "session",
        "update_source_rule require_write_access + _dataset_for_project + DatasetService.get_source_rule "
        "rule_id DatasetSourceRule.dataset_project_id == dataset.id + DatasetService.update_source_rule "
        "DatasetSourceRule.source_project_id DatasetService._require_source_access -> "
        "ProjectMemberService.has_access(source_project_id, user.id)",
    ),
    ApiPolicy(
        "POST",
        "/api/datasets/source-rules/{rule_id}/sync",
        "dataset_source_rule",
        "write_content",
        "session",
        "sync_source_rule require_write_access + _dataset_for_project + DatasetService.get_source_rule "
        "rule_id DatasetSourceRule.dataset_project_id == dataset.id + DatasetService.sync_source_rule "
        "DatasetSourceRule.source_project_id DatasetService._require_source_access -> "
        "ProjectMemberService.has_access(source_project_id, user.id); trace metadata weak-ref scope",
    ),
    ApiPolicy(
        "GET",
        "/api/datasets/current/records",
        "dataset_record",
        "read",
        "session",
        "list_current_records get_current_project + _dataset_for_project -> "
        "DatasetService.ensure_dataset_project filters DatasetProject.project_id == project.id + "
        "DatasetService.list_records filters DatasetRecord.dataset_project_id == dataset.id + "
        "DatasetService.responses_for_records filters DatasetResponse.record_id in record_ids and "
        "DatasetResponse.user_id == user.id",
    ),
    ApiPolicy(
        "GET",
        "/api/datasets/records/{record_id}",
        "dataset_record",
        "read",
        "session",
        "get_record get_current_project + _dataset_for_project -> "
        "DatasetService.ensure_dataset_project filters DatasetProject.project_id == project.id + "
        "DatasetService.get_record filters DatasetRecord.id == record_id and "
        "DatasetRecord.dataset_project_id == dataset.id + DatasetService.response_for_record "
        "filters DatasetResponse.record_id == record.id and DatasetResponse.user_id == user.id",
    ),
    ApiPolicy(
        "PATCH",
        "/api/datasets/records/{record_id}/response/me",
        "dataset_response",
        "manage",
        "session",
        "save_my_response require_write_access + _dataset_for_project -> "
        "DatasetService.ensure_dataset_project filters DatasetProject.project_id == project.id + "
        "DatasetService.get_record filters DatasetRecord.id == record_id and "
        "DatasetRecord.dataset_project_id == dataset.id + DatasetService.save_response writes "
        "DatasetResponse.dataset_project_id == record.dataset_project_id "
        "DatasetResponse.record_id == record.id DatasetResponse.user_id == user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/datasets/records/{record_id}/response/me/submit",
        "dataset_response",
        "manage",
        "session",
        "submit_my_response require_write_access + _dataset_for_project -> "
        "DatasetService.ensure_dataset_project filters DatasetProject.project_id == project.id + "
        "DatasetService.get_record filters DatasetRecord.id == record_id and "
        "DatasetRecord.dataset_project_id == dataset.id + DatasetService.save_response writes "
        "DatasetResponse.status submitted and DatasetResponse.user_id == user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/datasets/records/{record_id}/discard",
        "dataset_response",
        "manage",
        "session",
        "discard_record require_write_access + _dataset_for_project -> "
        "DatasetService.ensure_dataset_project filters DatasetProject.project_id == project.id + "
        "DatasetService.get_record filters DatasetRecord.id == record_id and "
        "DatasetRecord.dataset_project_id == dataset.id + DatasetService.discard_record -> "
        "DatasetService.save_response writes DatasetResponse.status discarded and "
        "DatasetResponse.user_id == user.id",
    ),
    ApiPolicy(
        "GET",
        "/api/datasets/current/export.zip",
        "dataset_project",
        "read",
        "session",
        "export_current_dataset get_current_project + _dataset_for_project -> "
        "DatasetService.ensure_dataset_project filters DatasetProject.project_id == project.id + "
        "DatasetService.export_zip -> DatasetService._export_records filters "
        "DatasetRecord.dataset_project_id == dataset.id and submitted mode requires "
        "DatasetResponse.dataset_project_id == dataset.id DatasetResponse.user_id == user.id "
        "DatasetResponse.status submitted",
    ),
    ApiPolicy(
        "GET",
        "/api/annotations/by-doc/{doc_id}/evaluations",
        "annotation_evaluation",
        "manage",
        "session",
        "list_evaluations get_current_project + _ensure_doc doc_id Doc.project_id == project.id + "
        "evaluation_service.list_evaluations_by_doc filters AnnotationEvaluation.doc_id == doc_id "
        "AnnotationEvaluation.user_id == user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/annotations/{annotation_id}/evaluations",
        "annotation_evaluation",
        "manage",
        "session",
        "create_evaluation get_current_project + _ensure_visible_annotation annotation_id body.doc_id "
        "Annotation.project_id == project.id and Annotation.user_id/global visibility + "
        "evaluation_service.get_evaluation rejects existing AnnotationEvaluation.user_id != user.id + "
        "evaluation_service.create_evaluation creates AnnotationEvaluation.annotation_id "
        "AnnotationEvaluation.doc_id AnnotationEvaluation.user_id == user.id",
    ),
    ApiPolicy(
        "PATCH",
        "/api/annotations/{annotation_id}/evaluations/{evaluation_id}",
        "annotation_evaluation",
        "manage",
        "session",
        "patch_evaluation get_current_project + evaluation_service.get_evaluation evaluation_id + "
        "AnnotationEvaluation.annotation_id == annotation_id + AnnotationEvaluation.user_id == user.id + "
        "_ensure_doc AnnotationEvaluation.doc_id Doc.project_id == project.id + _ensure_visible_annotation",
    ),
    ApiPolicy(
        "DELETE",
        "/api/annotations/{annotation_id}/evaluations/{evaluation_id}",
        "annotation_evaluation",
        "manage",
        "session",
        "delete_evaluation get_current_project + evaluation_service.get_evaluation evaluation_id + "
        "AnnotationEvaluation.annotation_id == annotation_id + AnnotationEvaluation.user_id == user.id + "
        "_ensure_doc AnnotationEvaluation.doc_id Doc.project_id == project.id + _ensure_visible_annotation",
    ),
    ApiPolicy(
        "PATCH",
        "/api/annotations/{annotation_id}/review-status",
        "annotation_review_state",
        "manage",
        "session",
        "patch_review_status get_current_project + _ensure_visible_annotation annotation_id body.doc_id "
        "Annotation.project_id == project.id and Annotation.user_id/global visibility + "
        "evaluation_service.set_review_status creates/checks AnnotationReviewState.user_id == user.id "
        "AnnotationReviewState.doc_id == body.doc_id",
    ),
    ApiPolicy(
        "GET",
        "/api/annotations/by-doc/{doc_id}/review-states",
        "annotation_review_state",
        "manage",
        "session",
        "list_review_states get_current_project + _ensure_doc doc_id Doc.project_id == project.id + "
        "evaluation_service.list_review_states_by_doc filters AnnotationReviewState.doc_id == doc_id "
        "AnnotationReviewState.user_id == user.id",
    ),
    ApiPolicy(
        "GET",
        "/api/annotations/by-doc/{doc_id}/evaluation-tags",
        "annotation_evaluation",
        "manage",
        "session",
        "list_evaluation_tags get_current_project + _ensure_doc doc_id Doc.project_id == project.id + "
        "evaluation_service.aggregate_tags_for_doc filters AnnotationEvaluation.doc_id == doc_id "
        "AnnotationEvaluation.user_id == user.id",
    ),
    ApiPolicy(
        "GET",
        "/api/annotations/by-doc/{doc_id}/items",
        "annotation",
        "read",
        "session",
        "list_annotations get_current_project + _ensure_doc doc_id Doc.project_id == project.id + "
        "annotation_service.list_by_doc filters Annotation.doc_id == doc_id and "
        "(Annotation.is_global or Annotation.user_id == user.id)",
    ),
    ApiPolicy(
        "POST",
        "/api/annotations/items",
        "annotation",
        "write_content",
        "session",
        "create_annotation require_write_access + _ensure_doc body.doc_id Doc.project_id == project.id + "
        "_ensure_annotation_upsert_allowed checks Annotation.project_id == project.id "
        "Annotation.doc_id == body.doc_id and Annotation.user_id == user.id or "
        "Annotation.is_global with ProjectMemberService.can_write + "
        "_ensure_annotation_workflow_ref_allowed workflow_id user/project scope + "
        "_ensure_annotation_conversation_ref_allowed conversation_id user/project scope + "
        "annotation_service.upsert project_id=project.id user_id=user.id",
        expected_foreign_status=404,
        notes=(
            "Foreign project/doc/workflow ids are hidden with 404; action also models "
            "read-only member 403 cases."
        ),
    ),
    ApiPolicy(
        "PATCH",
        "/api/annotations/items/{annotation_id}",
        "annotation",
        "manage",
        "session",
        "patch_annotation get_current_project + annotation_service.get annotation_id + "
        "_ensure_doc row.doc_id Doc.project_id == project.id + "
        "_ensure_annotation_patch_allowed Annotation.user_id == user.id or "
        "Annotation.is_global range-only with ProjectMemberService.can_write + annotation_service.patch",
    ),
    ApiPolicy(
        "DELETE",
        "/api/annotations/items/{annotation_id}",
        "annotation",
        "manage",
        "session",
        "delete_annotation get_current_project + annotation_service.get annotation_id + "
        "Annotation.project_id == project.id + Annotation.user_id == user.id or empty/global + "
        "_ensure_doc row.doc_id Doc.project_id == project.id + Annotation.is_global requires "
        "ProjectMemberService.can_write + annotation_service.delete",
    ),
    ApiPolicy(
        "GET",
        "/api/annotations/agent-suggestions/by-doc/{doc_id}",
        "annotation_agent_suggestion",
        "manage",
        "session",
        "list_agent_suggestions get_current_project + _ensure_doc doc_id Doc.project_id == project.id + "
        "annotation_agent_suggestion_service.list_by_doc filters AnnotationAgentSuggestion.doc_id == doc_id "
        "AnnotationAgentSuggestion.user_id == user.id",
    ),
    ApiPolicy(
        "POST",
        "/api/annotations/agent-suggestions/run",
        "annotation_agent_suggestion",
        "manage",
        "session",
        "run_agent_suggestions get_current_project + _ensure_doc body.doc_id Doc.project_id == project.id + "
        "WorkflowDefinition project/user scope WorkflowDefinition.project_id == project.id "
        "WorkflowDefinition.user_id == user.id or AgentRegistryService.resolve(project_id=project.id, user_id=user.id) + "
        "annotation_service.list_by_doc filters Annotation.user_id/global visibility user.id + "
        "annotation_agent_suggestion_service.upsert_generated creates AnnotationAgentSuggestion.project_id "
        "AnnotationAgentSuggestion.doc_id AnnotationAgentSuggestion.user_id AnnotationAgentSuggestion.agent_id",
    ),
    ApiPolicy(
        "PATCH",
        "/api/annotations/agent-suggestions/{suggestion_id}",
        "annotation_agent_suggestion",
        "manage",
        "session",
        "patch_agent_suggestion get_current_project + annotation_agent_suggestion_service.get_for_user "
        "suggestion_id AnnotationAgentSuggestion.user_id == user.id + "
        "AnnotationAgentSuggestion.project_id == project.id",
    ),
    ApiPolicy(
        "DELETE",
        "/api/annotations/agent-suggestions/{suggestion_id}",
        "annotation_agent_suggestion",
        "manage",
        "session",
        "delete_agent_suggestion get_current_project + AnnotationAgentSuggestion suggestion_id "
        "AnnotationAgentSuggestion.user_id == user.id AnnotationAgentSuggestion.project_id == project.id + "
        "annotation_agent_suggestion_service.delete",
    ),
    ApiPolicy(
        "GET",
        "/api/compile/compilers",
        "compile_environment",
        "read",
        "session",
        "get_current_user + compiler info",
    ),
    ApiPolicy(
        "POST",
        "/api/compile/rescan",
        "compile_environment",
        "admin",
        "session",
        "require_admin + compiler rescan",
        expected_foreign_status=403,
    ),
    ApiPolicy(
        "GET",
        "/api/notifications",
        "notification",
        "manage",
        "session",
        "select(Notification) Notification.user_id user_id order desc limit(50)",
    ),
    ApiPolicy(
        "GET",
        "/api/notifications/unread-count",
        "notification",
        "manage",
        "session",
        "select(Notification) Notification.user_id user_id + Notification.is_read unread filter",
    ),
    ApiPolicy(
        "POST",
        "/api/notifications/{notification_id}/read",
        "notification",
        "manage",
        "session",
        "notification_id + db.get(Notification) + Notification.user_id user_id owner before mark read",
    ),
    ApiPolicy(
        "POST",
        "/api/notifications/read-all",
        "notification",
        "manage",
        "session",
        "update(Notification) Notification.user_id user_id + Notification.is_read unread filter",
    ),
)

MCP_TRANSPORT_POLICIES: tuple[McpTransportPolicy, ...] = (
    McpTransportPolicy("GET", "/mcp/status", "mcp-token", "get_mcp_status"),
    McpTransportPolicy("GET", "/mcp", "mcp-token", "get_mcp_stream"),
    McpTransportPolicy("POST", "/mcp", "mcp-token", "handle_mcp_request"),
    McpTransportPolicy("DELETE", "/mcp", "mcp-token", "close_mcp_session"),
)

AGENT_COMMAND_POLICIES: tuple[AgentCommandPolicy, ...] = (
    AgentCommandPolicy(
        "superleaf_list_projects",
        "project",
        "list",
        "mcp-agent-command",
        "ProjectService.list + ProjectMemberService.list_shared_projects accepted members",
        notes="Lists only projects visible to ctx.user_id; no direct foreign id input.",
    ),
    AgentCommandPolicy(
        "superleaf_select_project",
        "project",
        "read",
        "mcp-agent-command",
        "project.require_project_access",
    ),
    AgentCommandPolicy(
        "project_list_docs",
        "doc",
        "read",
        "mcp-agent-command",
        "project.project_from_args",
    ),
    AgentCommandPolicy(
        "project_read_doc",
        "doc",
        "read",
        "mcp-agent-command",
        "project.project_from_args + project.require_doc",
    ),
    AgentCommandPolicy(
        "project_grep",
        "doc",
        "read",
        "mcp-agent-command",
        "project.project_from_args + project.grep",
    ),
    AgentCommandPolicy(
        "project_outline",
        "doc",
        "read",
        "mcp-agent-command",
        "project.project_from_args + project.require_doc",
    ),
    AgentCommandPolicy(
        "project_write_text_file",
        "doc",
        "write_content",
        "mcp-agent-command",
        "project.project_from_args + suggestions.require_agent_write + ProjectFsService",
    ),
    AgentCommandPolicy(
        "project_create_text_file",
        "doc",
        "write_content",
        "mcp-agent-command",
        "project.project_from_args + suggestions.require_agent_write + ProjectFsService",
        notes="Alias of project_write_text_file.",
    ),
    AgentCommandPolicy(
        "propose_doc_edit",
        "annotation",
        "write_content",
        "mcp-agent-command",
        "project.project_from_args + suggestions.require_agent_write + project.require_doc",
        notes=(
            "Creates a pending proposal annotation; existing body text changes "
            "only on later editor/Yjs acceptance."
        ),
    ),
    AgentCommandPolicy(
        "create_suggestion",
        "annotation",
        "write_content",
        "mcp-agent-command",
        "project.project_from_args + suggestions.require_agent_write + project.require_doc",
        notes="Creates an annotation card; does not mutate document body text.",
    ),
)

MCP_TRANSPORT_TEST_POLICIES: tuple[McpTransportTestPolicy, ...] = (
    McpTransportTestPolicy(
        "GET",
        "/mcp/status",
        "test/test_backend_mcp_rpc.py",
        "status route requires token/session and reports backend-native service state",
    ),
    McpTransportTestPolicy(
        "GET",
        "/mcp",
        "test/test_backend_mcp_rpc.py",
        "SSE route requires a valid token/session and rejects invalid Last-Event-ID",
    ),
    McpTransportTestPolicy(
        "POST",
        "/mcp",
        "test/test_backend_mcp_rpc.py",
        "initialize requires bearer token and tools/call hides foreign project/doc resources",
    ),
    McpTransportTestPolicy(
        "DELETE",
        "/mcp",
        "test/test_backend_mcp_rpc.py",
        "session delete closes the transport session and later calls with that session return 404",
    ),
)

AGENT_COMMAND_TEST_POLICIES: tuple[AgentCommandTestPolicy, ...] = (
    AgentCommandTestPolicy(
        "superleaf_list_projects",
        "test/test_superleaf_mcp_tools.py",
        "project listing includes owned/shared projects only",
    ),
    AgentCommandTestPolicy(
        "superleaf_select_project",
        "test/test_superleaf_mcp_tools.py",
        "project selection uses access-checked project resolution and hides foreign projects",
    ),
    AgentCommandTestPolicy(
        "project_list_docs",
        "test/test_superleaf_mcp_tools.py",
        "document listing scopes to the active or explicit project and rejects foreign projects",
    ),
    AgentCommandTestPolicy(
        "project_read_doc",
        "test/test_superleaf_mcp_tools.py",
        "document reads are range-capped and backend RPC hides foreign project/doc content",
    ),
    AgentCommandTestPolicy(
        "project_grep",
        "test/test_superleaf_mcp_tools.py",
        "grep rejects expensive patterns and searches only scoped project documents",
    ),
    AgentCommandTestPolicy(
        "project_outline",
        "test/test_superleaf_mcp_tools.py",
        "outline returns context only for access-checked project documents",
    ),
    AgentCommandTestPolicy(
        "project_write_text_file",
        "test/test_superleaf_mcp_write_tools.py",
        "write token/scope gates writes and foreign projects return 404 without mutation",
    ),
    AgentCommandTestPolicy(
        "project_create_text_file",
        "test/test_superleaf_mcp_write_tools.py",
        "create-file alias refuses overwrites and uses the same project/write gate",
    ),
    AgentCommandTestPolicy(
        "propose_doc_edit",
        "test/test_superleaf_mcp_write_tools.py",
        "read tokens cannot propose edits and foreign projects return 404 without mutation",
    ),
    AgentCommandTestPolicy(
        "create_suggestion",
        "test/test_superleaf_mcp_write_tools.py",
        "suggestion creation writes annotation cards only and foreign projects return 404 without mutation",
    ),
)

CROSS_USER_TEST_POLICIES: tuple[CrossUserTestPolicy, ...] = (
    CrossUserTestPolicy(
        "doc",
        "issue_collab_token",
        "test/test_collab_token_permissions.py",
        "collab token issue route rejects foreign docs",
        route_keys=(("GET", "/api/auth/collab-token"),),
    ),
    CrossUserTestPolicy(
        "doc",
        "issue_collab_token",
        "test/test_collab_token_permissions.py",
        "collab token verify route rejects doc mismatch",
        route_keys=(("GET", "/api/auth/verify"),),
    ),
    CrossUserTestPolicy(
        "doc",
        "read",
        "test/test_filesystem_idor_permissions.py",
        "filesystem doc detail route rejects foreign doc ids",
        route_keys=(("GET", "/api/docs/{doc_id}"),),
    ),
    CrossUserTestPolicy(
        "doc",
        "read",
        "test/test_filesystem_idor_permissions.py",
        "internal doc content route rejects foreign doc ids",
        route_keys=(("GET", "/api/internal/docs/{doc_id}/content"),),
    ),
    CrossUserTestPolicy(
        "doc",
        "read",
        "test/test_mcp_token_api.py",
        "MCP token project docs collection route rejects foreign projects",
        route_keys=(("GET", "/api/mcp/projects/{project_id}/docs"),),
    ),
    CrossUserTestPolicy(
        "doc",
        "read",
        "test/test_mcp_token_api.py",
        "MCP token project grep route rejects foreign projects",
        route_keys=(("GET", "/api/mcp/projects/{project_id}/grep"),),
    ),
    CrossUserTestPolicy(
        "doc",
        "read",
        "test/test_mcp_token_api.py",
        "MCP token document content route rejects foreign projects and docs",
        route_keys=(("GET", "/api/mcp/projects/{project_id}/docs/{doc_id}"),),
    ),
    CrossUserTestPolicy(
        "doc",
        "read",
        "test/test_mcp_token_api.py",
        "MCP token document outline route rejects foreign projects and docs",
        route_keys=(("GET", "/api/mcp/projects/{project_id}/docs/{doc_id}/outline"),),
    ),
    CrossUserTestPolicy(
        "doc",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "doc create route rejects foreign parent folders without mutation",
        route_keys=(("POST", "/api/docs"),),
    ),
    CrossUserTestPolicy(
        "doc",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "foreign doc update route returns 404 without mutation",
        route_keys=(("PUT", "/api/docs/{doc_id}"),),
    ),
    CrossUserTestPolicy(
        "doc",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "foreign doc collab flush route returns 404 without mutation",
        route_keys=(("POST", "/api/docs/{doc_id}/collab-flush"),),
    ),
    CrossUserTestPolicy(
        "document_label",
        "write_content",
        "test/test_compile_history_idor_permissions.py",
        "foreign doc label add route returns 404 without mutation",
        route_keys=(("POST", "/api/docs/{doc_id}/labels"),),
    ),
    CrossUserTestPolicy(
        "document_label",
        "write_content",
        "test/test_compile_history_idor_permissions.py",
        "foreign doc label remove route returns 404 without mutation",
        route_keys=(("DELETE", "/api/docs/{doc_id}/labels/{label_id}"),),
    ),
    CrossUserTestPolicy(
        "document_version",
        "read",
        "test/test_compile_history_idor_permissions.py",
        "foreign doc version collection route returns 404",
        route_keys=(("GET", "/api/docs/{doc_id}/versions"),),
    ),
    CrossUserTestPolicy(
        "document_version",
        "read",
        "test/test_compile_history_idor_permissions.py",
        "foreign doc diff route returns 404",
        route_keys=(("GET", "/api/docs/{doc_id}/diff"),),
    ),
    CrossUserTestPolicy(
        "document_version",
        "read",
        "test/test_compile_history_idor_permissions.py",
        "foreign doc version detail route returns 404",
        route_keys=(("GET", "/api/docs/{doc_id}/versions/{version}"),),
    ),
    CrossUserTestPolicy(
        "document_version",
        "restore",
        "test/test_compile_history_idor_permissions.py",
        "foreign doc restore route returns 404 without mutation",
    ),
    CrossUserTestPolicy(
        "file_blob",
        "read",
        "test/test_filesystem_idor_permissions.py",
        "foreign file download route returns 404",
    ),
    CrossUserTestPolicy(
        "file_blob",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "foreign file upload folder route returns 404 without mutation",
        route_keys=(("POST", "/api/files/upload"),),
    ),
    CrossUserTestPolicy(
        "file_blob",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "foreign file convert route returns 404 without mutation",
        route_keys=(("POST", "/api/files/{file_id}/convert-to-doc"),),
    ),
    CrossUserTestPolicy(
        "folder",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "foreign folder body references and write routes return 404 without mutation",
    ),
    CrossUserTestPolicy(
        "mcp_token",
        "manage",
        "test/test_mcp_token_api.py",
        "MCP whoami route reports presented token owner and scope",
        route_keys=(("GET", "/api/mcp/whoami"),),
    ),
    CrossUserTestPolicy(
        "mcp_token",
        "manage",
        "test/test_mcp_token_api.py",
        "MCP token list route hides other users and revoked tokens",
        route_keys=(("GET", "/api/mcp/tokens"),),
    ),
    CrossUserTestPolicy(
        "mcp_token",
        "manage",
        "test/test_mcp_token_api.py",
        "MCP token create route assigns token rows to current session user",
        route_keys=(("POST", "/api/mcp/tokens"),),
    ),
    CrossUserTestPolicy(
        "mcp_token",
        "manage",
        "test/test_mcp_token_api.py",
        "MCP token revoke route hides foreign tokens without revocation",
        route_keys=(("DELETE", "/api/mcp/tokens/{token_id}"),),
    ),
    CrossUserTestPolicy(
        "operation",
        "read",
        "test/test_compile_history_idor_permissions.py",
        "foreign doc operation history route returns 404",
    ),
    CrossUserTestPolicy(
        "operation",
        "write_content",
        "test/test_compile_history_idor_permissions.py",
        "foreign doc operation write route returns 404 without mutation",
    ),
    CrossUserTestPolicy(
        "project",
        "admin",
        "test/test_project_idor_permissions.py",
        "foreign project update route returns 404 and non-owner collaborator returns 403",
    ),
    CrossUserTestPolicy(
        "project",
        "compile",
        "test/test_compile_history_idor_permissions.py",
        "foreign project compile route returns 404 before compiler services",
        route_keys=(("POST", "/api/compile"),),
    ),
    CrossUserTestPolicy(
        "project",
        "compile",
        "test/test_compile_history_idor_permissions.py",
        "foreign project compile settings write route returns 404 before compiler services",
        route_keys=(("PUT", "/api/compile/settings"),),
    ),
    CrossUserTestPolicy(
        "project",
        "compile_read",
        "test/test_compile_history_idor_permissions.py",
        "compile settings read route hides foreign project headers",
        route_keys=(("GET", "/api/compile/settings"),),
    ),
    CrossUserTestPolicy(
        "project",
        "compile_read",
        "test/test_compile_history_idor_permissions.py",
        "compile log route hides foreign project headers",
        route_keys=(("GET", "/api/compile/log"),),
    ),
    CrossUserTestPolicy(
        "project",
        "compile_read",
        "test/test_compile_history_idor_permissions.py",
        "compile SyncTeX to-PDF route hides foreign project headers before compiler service",
        route_keys=(("POST", "/api/compile/sync-to-pdf"),),
    ),
    CrossUserTestPolicy(
        "project",
        "compile_read",
        "test/test_compile_history_idor_permissions.py",
        "compile SyncTeX from-PDF route hides foreign project headers before compiler service",
        route_keys=(("POST", "/api/compile/sync-from-pdf"),),
    ),
    CrossUserTestPolicy(
        "project",
        "compile_read",
        "test/test_compile_history_idor_permissions.py",
        "compile PDF path route hides foreign projects",
        route_keys=(("GET", "/api/projects/{project_id}/compile.pdf"),),
    ),
    CrossUserTestPolicy(
        "project",
        "create",
        "test/test_project_idor_permissions.py",
        "project create route assigns ownership to current session",
        route_keys=(("POST", "/api/projects"),),
    ),
    CrossUserTestPolicy(
        "project",
        "create",
        "test/test_project_idor_permissions.py",
        "project GitHub import route assigns ownership and rejects foreign dataset refs",
        route_keys=(("POST", "/api/projects/import/github"),),
    ),
    CrossUserTestPolicy(
        "project",
        "delete",
        "test/test_project_idor_permissions.py",
        "foreign project delete route returns 404",
    ),
    CrossUserTestPolicy(
        "project",
        "list",
        "test/test_project_idor_permissions.py",
        "project list hides foreign projects",
    ),
    CrossUserTestPolicy(
        "project",
        "read",
        "test/test_filesystem_idor_permissions.py",
        "filesystem project tree route hides foreign projects",
        route_keys=(("GET", "/api/project/tree"),),
    ),
    CrossUserTestPolicy(
        "project",
        "read",
        "test/test_filesystem_idor_permissions.py",
        "project zip export route hides foreign projects",
        route_keys=(("GET", "/api/projects/{project_id}/export.zip"),),
    ),
    CrossUserTestPolicy(
        "project",
        "read",
        "test/test_project_idor_permissions.py",
        "project online route hides foreign projects",
        route_keys=(("GET", "/api/projects/{project_id}/online"),),
    ),
    CrossUserTestPolicy(
        "project",
        "read",
        "test/test_project_idor_permissions.py",
        "project events route hides foreign projects",
        route_keys=(("GET", "/api/projects/{project_id}/events"),),
    ),
    CrossUserTestPolicy(
        "project",
        "read",
        "test/test_project_idor_permissions.py",
        "project annotation-training export route hides foreign projects",
        route_keys=(
            ("GET", "/api/projects/{project_id}/annotation-training-export"),
        ),
    ),
    CrossUserTestPolicy(
        "project",
        "read",
        "test/test_mcp_token_api.py",
        "MCP token project listing includes only accessible projects",
        route_keys=(("GET", "/api/mcp/projects"),),
    ),
    CrossUserTestPolicy(
        "project",
        "read_owned",
        "test/test_project_idor_permissions.py",
        "foreign project detail route returns 404",
    ),
    CrossUserTestPolicy(
        "project",
        "refresh_skill_cache",
        "test/test_project_idor_permissions.py",
        "read-only collaborators receive 403 on skill-cache refresh",
    ),
    CrossUserTestPolicy(
        "project",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "project name write route rejects foreign project headers without mutation",
        route_keys=(("PUT", "/api/project/name"),),
    ),
    CrossUserTestPolicy(
        "project",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "project zip import route rejects foreign project headers without mutation",
        route_keys=(("POST", "/api/project/import.zip"),),
    ),
    CrossUserTestPolicy(
        "project",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "project entity rename route rejects foreign project resources without mutation",
        route_keys=(("POST", "/api/entities/{entity_type}/{entity_id}/rename"),),
    ),
    CrossUserTestPolicy(
        "project",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "project entity move route rejects foreign project resources without mutation",
        route_keys=(("POST", "/api/entities/{entity_type}/{entity_id}/move"),),
    ),
    CrossUserTestPolicy(
        "project",
        "write_content",
        "test/test_filesystem_idor_permissions.py",
        "project entity delete route rejects foreign project resources without mutation",
        route_keys=(("DELETE", "/api/entities/{entity_type}/{entity_id}"),),
    ),
    CrossUserTestPolicy(
        "project",
        "write_content",
        "test/test_project_idor_permissions.py",
        "project skill-data package route rejects foreign target projects without mutation",
        route_keys=(("POST", "/api/projects/{project_id}/skill-data/from-dataset"),),
    ),
    CrossUserTestPolicy(
        "project",
        "write_content",
        "test/test_project_idor_permissions.py",
        "project skill-data clear route rejects foreign target projects without mutation",
        route_keys=(("DELETE", "/api/projects/{project_id}/skill-data"),),
    ),
    CrossUserTestPolicy(
        "project",
        "write_content",
        "test/test_project_idor_permissions.py",
        "project skill-data source route rejects foreign data project refs without mutation",
        route_keys=(("POST", "/api/projects/{project_id}/skill-data/from-dataset"),),
    ),
    CrossUserTestPolicy(
        "project_archive_binding",
        "manage",
        "test/test_project_idor_permissions.py",
        "foreign archive binding manage routes return 404",
    ),
    CrossUserTestPolicy(
        "project_archive_binding",
        "read",
        "test/test_project_idor_permissions.py",
        "foreign archive status route returns 404",
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "read",
        "test/test_project_idor_permissions.py",
        "foreign archive snapshot list route returns 404",
        route_keys=(("GET", "/api/projects/{project_id}/archive/snapshots"),),
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "read",
        "test/test_project_idor_permissions.py",
        "foreign major-version list route returns 404",
        route_keys=(("GET", "/api/projects/{project_id}/major-versions"),),
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "read",
        "test/test_project_idor_permissions.py",
        "foreign major-version detail route returns 404",
        route_keys=(("GET", "/api/projects/{project_id}/major-versions/{sha}"),),
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "read",
        "test/test_project_idor_permissions.py",
        "foreign major-version artifact download route returns 404",
        route_keys=(("GET", "/api/projects/{project_id}/major-versions/{sha}/download"),),
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "read",
        "test/test_project_idor_permissions.py",
        "foreign major-version diff route returns 404",
        route_keys=(("GET", "/api/projects/{project_id}/major-versions/{sha}/diff"),),
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "read",
        "test/test_project_idor_permissions.py",
        "foreign major-version file route returns 404",
        route_keys=(
            ("GET", "/api/projects/{project_id}/major-versions/{sha}/files/{path:path}"),
        ),
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "write_content",
        "test/test_project_idor_permissions.py",
        "foreign archive GitHub import route returns 404",
        route_keys=(("POST", "/api/projects/{project_id}/archive/github/import"),),
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "write_content",
        "test/test_project_idor_permissions.py",
        "foreign archive GitHub push route returns 404",
        route_keys=(("POST", "/api/projects/{project_id}/archive/github/push"),),
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "write_content",
        "test/test_project_idor_permissions.py",
        "foreign archive snapshot create route returns 404",
        route_keys=(("POST", "/api/projects/{project_id}/archive/snapshots"),),
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "write_content",
        "test/test_project_idor_permissions.py",
        "foreign major-version create route returns 404",
        route_keys=(("POST", "/api/projects/{project_id}/major-versions"),),
    ),
    CrossUserTestPolicy(
        "project_archive_snapshot",
        "write_content",
        "test/test_project_idor_permissions.py",
        "foreign major-version restore route returns 404",
        route_keys=(("POST", "/api/projects/{project_id}/major-versions/{sha}/restore"),),
    ),
    CrossUserTestPolicy(
        "project_member",
        "manage",
        "test/test_project_idor_permissions.py",
        "foreign member add route returns 404 and non-owner collaborator returns 403",
        route_keys=(("POST", "/api/projects/{project_id}/members"),),
    ),
    CrossUserTestPolicy(
        "project_member",
        "manage",
        "test/test_project_idor_permissions.py",
        "foreign member remove route returns 404 and non-owner collaborator returns 403",
        route_keys=(("DELETE", "/api/projects/{project_id}/members/{user_id}"),),
    ),
    CrossUserTestPolicy(
        "project_member",
        "read",
        "test/test_project_idor_permissions.py",
        "member list filters pending invite details for non-owners and hides foreign projects",
    ),
    CrossUserTestPolicy(
        "recent_collaborator",
        "read",
        "test/test_recent_collaborator_config_permissions.py",
        "recent collaborator list only returns current-user rows",
    ),
    CrossUserTestPolicy(
        "annotation",
        "manage",
        "test/test_annotation_upsert_security.py",
        "foreign/private annotation patch route returns 404/403 without mutation",
        route_keys=(("PATCH", "/api/annotations/items/{annotation_id}"),),
    ),
    CrossUserTestPolicy(
        "annotation",
        "manage",
        "test/test_annotation_upsert_security.py",
        "foreign/private annotation delete route returns 404/403 without mutation",
        route_keys=(("DELETE", "/api/annotations/items/{annotation_id}"),),
    ),
    CrossUserTestPolicy(
        "annotation",
        "read",
        "test/test_evaluation_scope_security.py",
        "annotation read routes hide foreign project headers",
    ),
    CrossUserTestPolicy(
        "annotation",
        "write_content",
        "test/test_annotation_upsert_security.py",
        "annotation create rejects foreign workflow and conversation references",
    ),
    CrossUserTestPolicy(
        "annotation_agent_suggestion",
        "manage",
        "test/test_annotation_upsert_security.py",
        "agent suggestion list route hides other-user suggestion rows",
        route_keys=(("GET", "/api/annotations/agent-suggestions/by-doc/{doc_id}"),),
    ),
    CrossUserTestPolicy(
        "annotation_agent_suggestion",
        "manage",
        "test/test_annotation_upsert_security.py",
        "agent suggestion run route rejects foreign agents before writing suggestion rows",
        route_keys=(("POST", "/api/annotations/agent-suggestions/run"),),
    ),
    CrossUserTestPolicy(
        "annotation_agent_suggestion",
        "manage",
        "test/test_annotation_upsert_security.py",
        "agent suggestion patch route returns 404 without mutating foreign rows",
        route_keys=(("PATCH", "/api/annotations/agent-suggestions/{suggestion_id}"),),
    ),
    CrossUserTestPolicy(
        "annotation_agent_suggestion",
        "manage",
        "test/test_annotation_upsert_security.py",
        "agent suggestion delete route returns 404 without mutating foreign rows",
        route_keys=(("DELETE", "/api/annotations/agent-suggestions/{suggestion_id}"),),
    ),
    CrossUserTestPolicy(
        "annotation_evaluation",
        "manage",
        "test/test_evaluation_scope_security.py",
        "evaluation list route rejects foreign docs and omits other-user context",
        route_keys=(("GET", "/api/annotations/by-doc/{doc_id}/evaluations"),),
    ),
    CrossUserTestPolicy(
        "annotation_evaluation",
        "manage",
        "test/test_evaluation_scope_security.py",
        "evaluation tags route rejects foreign docs and omits other-user context",
        route_keys=(("GET", "/api/annotations/by-doc/{doc_id}/evaluation-tags"),),
    ),
    CrossUserTestPolicy(
        "annotation_evaluation",
        "manage",
        "test/test_evaluation_scope_security.py",
        "evaluation create routes reject private or foreign-project annotations",
        route_keys=(("POST", "/api/annotations/{annotation_id}/evaluations"),),
    ),
    CrossUserTestPolicy(
        "annotation_evaluation",
        "manage",
        "test/test_evaluation_scope_security.py",
        "evaluation patch route hides other-user rows without mutation",
        route_keys=(("PATCH", "/api/annotations/{annotation_id}/evaluations/{evaluation_id}"),),
    ),
    CrossUserTestPolicy(
        "annotation_evaluation",
        "manage",
        "test/test_evaluation_scope_security.py",
        "evaluation delete route hides other-user rows without mutation",
        route_keys=(("DELETE", "/api/annotations/{annotation_id}/evaluations/{evaluation_id}"),),
    ),
    CrossUserTestPolicy(
        "annotation_review_state",
        "manage",
        "test/test_evaluation_scope_security.py",
        "review state list route rejects other-user rows and foreign/private annotations",
        route_keys=(("GET", "/api/annotations/by-doc/{doc_id}/review-states"),),
    ),
    CrossUserTestPolicy(
        "annotation_review_state",
        "manage",
        "test/test_evaluation_scope_security.py",
        "review status patch route rejects other-user rows and foreign/private annotations",
        route_keys=(("PATCH", "/api/annotations/{annotation_id}/review-status"),),
    ),
    CrossUserTestPolicy(
        "cached_workflow",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "cached workflow list route scopes cached workflows to user and native workflows to project",
        route_keys=(("GET", "/api/workflows"),),
    ),
    CrossUserTestPolicy(
        "cached_workflow",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "cached workflow disable route hides foreign workflows without mutation",
        route_keys=(("POST", "/api/workflows/{workflow_id}/disable"),),
    ),
    CrossUserTestPolicy(
        "cached_workflow",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "cached workflow enable route hides foreign workflows without mutation",
        route_keys=(("POST", "/api/workflows/{workflow_id}/enable"),),
    ),
    CrossUserTestPolicy(
        "cached_workflow",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "cached workflow run route hides foreign workflows before provider execution",
        route_keys=(("POST", "/api/workflows/{workflow_id}/run"),),
    ),
    CrossUserTestPolicy(
        "compile_environment",
        "admin",
        "test/test_admin_api_permissions.py",
        "non-admin compile rescan returns 403 before compiler service access",
    ),
    CrossUserTestPolicy(
        "compile_environment",
        "read",
        "test/test_compile_audit_permissions.py",
        "compiler listing requires authentication and returns only compiler metadata",
    ),
    CrossUserTestPolicy(
        "conversation",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "conversation list route hides foreign conversations",
        route_keys=(("GET", "/api/conversations"),),
    ),
    CrossUserTestPolicy(
        "conversation",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "conversation create route rejects foreign projects and workflows without mutation",
        route_keys=(("POST", "/api/conversations"),),
    ),
    CrossUserTestPolicy(
        "conversation",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "conversation id read route rejects foreign conversations",
        route_keys=(("GET", "/api/conversations/{conversation_id}"),),
    ),
    CrossUserTestPolicy(
        "conversation",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "conversation patch route rejects foreign conversations without mutation",
        route_keys=(("PATCH", "/api/conversations/{conversation_id}"),),
    ),
    CrossUserTestPolicy(
        "conversation",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "conversation delete route rejects foreign conversations without mutation",
        route_keys=(("DELETE", "/api/conversations/{conversation_id}"),),
    ),
    CrossUserTestPolicy(
        "dataset_project",
        "read",
        "test/test_dataset_idor_permissions.py",
        "dataset current route hides foreign project rows",
        route_keys=(("GET", "/api/datasets/current"),),
    ),
    CrossUserTestPolicy(
        "dataset_project",
        "read",
        "test/test_dataset_idor_permissions.py",
        "dataset filter options route hides foreign project rows",
        route_keys=(("GET", "/api/datasets/current/filter-options"),),
    ),
    CrossUserTestPolicy(
        "dataset_project",
        "read",
        "test/test_dataset_idor_permissions.py",
        "dataset export route hides foreign project data and headers",
        route_keys=(("GET", "/api/datasets/current/export.zip"),),
    ),
    CrossUserTestPolicy(
        "dataset_project",
        "write_content",
        "test/test_dataset_idor_permissions.py",
        "dataset write routes hide foreign project headers",
    ),
    CrossUserTestPolicy(
        "dataset_record",
        "read",
        "test/test_dataset_idor_permissions.py",
        "dataset record list route hides foreign dataset resources",
        route_keys=(("GET", "/api/datasets/current/records"),),
    ),
    CrossUserTestPolicy(
        "dataset_record",
        "read",
        "test/test_dataset_idor_permissions.py",
        "dataset record detail route hides foreign dataset resources",
        route_keys=(("GET", "/api/datasets/records/{record_id}"),),
    ),
    CrossUserTestPolicy(
        "dataset_response",
        "manage",
        "test/test_dataset_idor_permissions.py",
        "dataset response update route hides foreign record ids and rejects read-only members",
        route_keys=(("PATCH", "/api/datasets/records/{record_id}/response/me"),),
    ),
    CrossUserTestPolicy(
        "dataset_response",
        "manage",
        "test/test_dataset_idor_permissions.py",
        "dataset response submit route hides foreign record ids and rejects read-only members",
        route_keys=(("POST", "/api/datasets/records/{record_id}/response/me/submit"),),
    ),
    CrossUserTestPolicy(
        "dataset_response",
        "manage",
        "test/test_dataset_idor_permissions.py",
        "dataset record discard route hides foreign record ids and rejects read-only members",
        route_keys=(("POST", "/api/datasets/records/{record_id}/discard"),),
    ),
    CrossUserTestPolicy(
        "dataset_source_rule",
        "read",
        "test/test_dataset_idor_permissions.py",
        "dataset source-rule listing hides foreign project rows",
    ),
    CrossUserTestPolicy(
        "dataset_source_rule",
        "write_content",
        "test/test_dataset_idor_permissions.py",
        "dataset source-rule collection create rejects foreign project and source refs",
        route_keys=(("POST", "/api/datasets/current/source-rules"),),
    ),
    CrossUserTestPolicy(
        "dataset_source_rule",
        "write_content",
        "test/test_dataset_idor_permissions.py",
        "dataset source-rule update route rejects foreign project and source refs",
        route_keys=(("PATCH", "/api/datasets/source-rules/{rule_id}"),),
    ),
    CrossUserTestPolicy(
        "dataset_source_rule",
        "write_content",
        "test/test_dataset_idor_permissions.py",
        "dataset source-rule sync route rejects foreign project and source refs",
        route_keys=(("POST", "/api/datasets/source-rules/{rule_id}/sync"),),
    ),
    CrossUserTestPolicy(
        "github_account",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "GitHub account lookup scopes to current user",
        route_keys=(("GET", "/api/github/account"),),
    ),
    CrossUserTestPolicy(
        "github_account",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "GitHub account disconnect scopes to current user",
        route_keys=(("DELETE", "/api/github/account"),),
    ),
    CrossUserTestPolicy(
        "github_account",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "GitHub token connection assigns account ownership to current user",
        route_keys=(("POST", "/api/github/token"),),
    ),
    CrossUserTestPolicy(
        "github_account",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "GitHub OAuth start records state for current user",
        route_keys=(("POST", "/api/github/oauth/start"),),
    ),
    CrossUserTestPolicy(
        "github_account",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "GitHub OAuth callback rejects foreign state without consuming it",
        route_keys=(("GET", "/api/github/oauth/callback"),),
    ),
    CrossUserTestPolicy(
        "github_account",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "GitHub device start performs request without mutating foreign accounts",
        route_keys=(("POST", "/api/github/device/start"),),
    ),
    CrossUserTestPolicy(
        "github_account",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "GitHub device poll connects returned account to current user",
        route_keys=(("POST", "/api/github/device/poll"),),
    ),
    CrossUserTestPolicy(
        "local_agent_host_package",
        "read",
        "test/test_native_agent_metadata_permissions.py",
        "Local Agent Host package metadata route requires authenticated sessions",
        route_keys=(("GET", "/api/native-agent/local-agent-host/package"),),
    ),
    CrossUserTestPolicy(
        "local_agent_host_package",
        "read",
        "test/test_native_agent_metadata_permissions.py",
        "Local Agent Host update metadata route requires authenticated sessions",
        route_keys=(("GET", "/api/native-agent/local-agent-host/update"),),
    ),
    CrossUserTestPolicy(
        "local_agent_host_package",
        "read",
        "test/test_native_agent_metadata_permissions.py",
        "Local Agent Host download route requires authenticated sessions",
        route_keys=(("GET", "/api/native-agent/local-agent-host/download"),),
    ),
    CrossUserTestPolicy(
        "mcp_catalog",
        "read",
        "test/test_native_agent_metadata_permissions.py",
        "MCP catalog route requires authenticated sessions",
        route_keys=(("GET", "/api/native-agent/mcp/catalog"),),
    ),
    CrossUserTestPolicy(
        "mcp_catalog",
        "read",
        "test/test_native_agent_metadata_permissions.py",
        "MCP policy route requires authenticated sessions",
        route_keys=(("GET", "/api/native-agent/mcp/policy"),),
    ),
    CrossUserTestPolicy(
        "mcp_catalog",
        "probe",
        "test/test_native_agent_metadata_permissions.py",
        "MCP probe route requires authenticated sessions",
        route_keys=(("POST", "/api/native-agent/mcp/probe"),),
    ),
    CrossUserTestPolicy(
        "mcp_catalog",
        "probe",
        "test/test_native_agent_metadata_permissions.py",
        "MCP golden-test route requires authenticated sessions",
        route_keys=(("POST", "/api/native-agent/mcp/golden-test"),),
    ),
    CrossUserTestPolicy(
        "mcp_catalog",
        "probe",
        "test/test_mcp_catalog_security.py",
        "MCP catalog probe rejects private-network preset URLs",
        route_keys=(("POST", "/api/native-agent/mcp/probe"),),
    ),
    CrossUserTestPolicy(
        "mcp_catalog",
        "probe",
        "test/test_mcp_catalog_security.py",
        "MCP catalog golden-test rejects private-network URLs",
        route_keys=(("POST", "/api/native-agent/mcp/golden-test"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "conversation message list route rejects foreign conversations without mutation",
        route_keys=(("GET", "/api/conversations/{conversation_id}/messages"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "conversation message send route rejects foreign conversations without mutation",
        route_keys=(("POST", "/api/conversations/{conversation_id}/messages"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "conversation message inject route rejects foreign conversations without mutation",
        route_keys=(
            ("POST", "/api/conversations/{conversation_id}/messages/inject"),
        ),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Codex prepare route rejects foreign conversations without mutation",
        route_keys=(("POST", "/api/conversations/{conversation_id}/browser-codex/prepare"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Codex tool route rejects foreign conversations without mutation",
        route_keys=(("POST", "/api/conversations/{conversation_id}/browser-codex/tool"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Codex finish route rejects foreign conversations without mutation",
        route_keys=(
            ("POST", "/api/conversations/{conversation_id}/browser-codex/finish"),
        ),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Claude prepare route rejects foreign conversations without mutation",
        route_keys=(("POST", "/api/conversations/{conversation_id}/browser-claude/prepare"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Claude tool route rejects foreign conversations without mutation",
        route_keys=(("POST", "/api/conversations/{conversation_id}/browser-claude/tool"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Claude finish route rejects foreign conversations without mutation",
        route_keys=(
            ("POST", "/api/conversations/{conversation_id}/browser-claude/finish"),
        ),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Nanobot prepare route rejects foreign conversations without mutation",
        route_keys=(("POST", "/api/conversations/{conversation_id}/browser-nanobot/prepare"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Nanobot tool route rejects foreign conversations without mutation",
        route_keys=(("POST", "/api/conversations/{conversation_id}/browser-nanobot/tool"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Nanobot finish route rejects foreign conversations without mutation",
        route_keys=(
            ("POST", "/api/conversations/{conversation_id}/browser-nanobot/finish"),
        ),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Codex tool route rejects foreign active documents before runner",
        route_keys=(("POST", "/api/conversations/{conversation_id}/browser-codex/tool"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Claude tool route rejects foreign active documents before runner",
        route_keys=(("POST", "/api/conversations/{conversation_id}/browser-claude/tool"),),
    ),
    CrossUserTestPolicy(
        "message",
        "manage",
        "test/test_conversation_idor_permissions.py",
        "browser Nanobot tool route rejects foreign active documents before runner",
        route_keys=(
            ("POST", "/api/conversations/{conversation_id}/browser-nanobot/tool"),
        ),
    ),
    CrossUserTestPolicy(
        "native_agent",
        "read",
        "test/test_native_agent_private_idor_permissions.py",
        "native agent list route hides foreign project rows",
        route_keys=(("GET", "/api/native-agent/agents"),),
    ),
    CrossUserTestPolicy(
        "native_agent",
        "read",
        "test/test_native_agent_private_idor_permissions.py",
        "native agent workspace tree route hides foreign project rows",
        route_keys=(("GET", "/api/native-agent/agents/{agent_id}/workspace/tree"),),
    ),
    CrossUserTestPolicy(
        "native_agent",
        "write_content",
        "test/test_native_agent_private_idor_permissions.py",
        "native agent create route rejects foreign providers and skills without mutation",
        route_keys=(("POST", "/api/native-agent/agents"),),
    ),
    CrossUserTestPolicy(
        "native_agent",
        "write_content",
        "test/test_native_agent_private_idor_permissions.py",
        "native agent patch route rejects foreign agent rows without mutation",
        route_keys=(("PATCH", "/api/native-agent/agents/{agent_id}"),),
    ),
    CrossUserTestPolicy(
        "native_agent",
        "write_content",
        "test/test_native_agent_private_idor_permissions.py",
        "native agent delete route rejects foreign agent rows without mutation",
        route_keys=(("DELETE", "/api/native-agent/agents/{agent_id}"),),
    ),
    CrossUserTestPolicy(
        "native_agent_credential",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native agent credential list route hides foreign rows",
        route_keys=(("GET", "/api/native-agent/credentials"),),
    ),
    CrossUserTestPolicy(
        "native_agent_credential",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native agent credential creation assigns ownership to current user",
        route_keys=(("POST", "/api/native-agent/credentials"),),
    ),
    CrossUserTestPolicy(
        "native_agent_credential",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native agent credential patch route rejects foreign rows without mutation",
        route_keys=(("PATCH", "/api/native-agent/credentials/{credential_id}"),),
    ),
    CrossUserTestPolicy(
        "native_agent_credential",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native agent credential delete route rejects foreign rows without mutation",
        route_keys=(("DELETE", "/api/native-agent/credentials/{credential_id}"),),
    ),
    CrossUserTestPolicy(
        "native_agent_credential",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native agent credential probe route rejects foreign rows before remote calls",
        route_keys=(
            ("POST", "/api/native-agent/credentials/{credential_id}/probe"),
        ),
    ),
    CrossUserTestPolicy(
        "native_agent_skill_install",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "agent skill install routes reject foreign agent rows",
    ),
    CrossUserTestPolicy(
        "native_agent_skill_install",
        "read",
        "test/test_native_agent_private_idor_permissions.py",
        "agent skill list routes reject foreign agent rows",
    ),
    CrossUserTestPolicy(
        "native_mcp_server",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native MCP server list route hides foreign rows",
        route_keys=(("GET", "/api/native-agent/mcp/servers"),),
    ),
    CrossUserTestPolicy(
        "native_mcp_server",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native MCP custom server creation assigns ownership to current user",
        route_keys=(("POST", "/api/native-agent/mcp/servers"),),
    ),
    CrossUserTestPolicy(
        "native_mcp_server",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native MCP preset server creation assigns ownership to current user",
        route_keys=(("POST", "/api/native-agent/mcp/servers/from-preset/{preset_id}"),),
    ),
    CrossUserTestPolicy(
        "native_mcp_server",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native MCP server patch route rejects foreign rows without mutation",
        route_keys=(("PATCH", "/api/native-agent/mcp/servers/{server_id}"),),
    ),
    CrossUserTestPolicy(
        "native_mcp_server",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native MCP server delete route rejects foreign rows without mutation",
        route_keys=(("DELETE", "/api/native-agent/mcp/servers/{server_id}"),),
    ),
    CrossUserTestPolicy(
        "native_mcp_server",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native MCP server probe route rejects foreign rows before execution",
        route_keys=(("POST", "/api/native-agent/mcp/servers/{server_id}/probe"),),
    ),
    CrossUserTestPolicy(
        "native_mcp_server",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "native MCP server golden-test route rejects foreign rows before execution",
        route_keys=(("POST", "/api/native-agent/mcp/servers/{server_id}/golden-test"),),
    ),
    CrossUserTestPolicy(
        "notification",
        "manage",
        "test/test_notification_idor_permissions.py",
        "notification list route hides other users",
        route_keys=(("GET", "/api/notifications"),),
    ),
    CrossUserTestPolicy(
        "notification",
        "manage",
        "test/test_notification_idor_permissions.py",
        "notification unread-count route counts only current-user unread rows",
        route_keys=(("GET", "/api/notifications/unread-count"),),
    ),
    CrossUserTestPolicy(
        "notification",
        "manage",
        "test/test_notification_idor_permissions.py",
        "notification mark-read route hides foreign notifications without mutation",
        route_keys=(("POST", "/api/notifications/{notification_id}/read"),),
    ),
    CrossUserTestPolicy(
        "notification",
        "manage",
        "test/test_notification_idor_permissions.py",
        "notification read-all route marks only current-user rows",
        route_keys=(("POST", "/api/notifications/read-all"),),
    ),
    CrossUserTestPolicy(
        "official_badge_ui",
        "admin",
        "test/test_native_agent_metadata_permissions.py",
        "official badge style update returns 403 for non-admin users without mutation",
    ),
    CrossUserTestPolicy(
        "official_badge_ui",
        "read",
        "test/test_native_agent_metadata_permissions.py",
        "official badge metadata route requires authenticated session",
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider list route hides other users' providers",
        route_keys=(("GET", "/api/providers"),),
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider creation assigns ownership to current user and ignores body ownership",
        route_keys=(("POST", "/api/providers"),),
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider patch route rejects foreign provider rows without mutation",
        route_keys=(("PATCH", "/api/providers/{provider_id}"),),
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider delete route rejects foreign provider rows without mutation",
        route_keys=(("DELETE", "/api/providers/{provider_id}"),),
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider activate route rejects foreign provider rows without mutation",
        route_keys=(
            ("POST", "/api/providers/{provider_id}/activate"),
        ),
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider probe route rejects foreign providers before remote calls",
        route_keys=(("POST", "/api/providers/{provider_id}/probe"),),
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider models route rejects foreign providers before remote calls",
        route_keys=(("GET", "/api/providers/{provider_id}/models"),),
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider browser Codex agent sync route rejects foreign provider rows without mutation",
        route_keys=(("POST", "/api/providers/{provider_id}/browser-codex-agent"),),
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider browser Claude agent sync route rejects foreign provider rows without mutation",
        route_keys=(("POST", "/api/providers/{provider_id}/browser-claude-agent"),),
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider browser Nanobot model sync route rejects foreign provider rows without mutation",
        route_keys=(("POST", "/api/providers/{provider_id}/browser-nanobot-models"),),
    ),
    CrossUserTestPolicy(
        "provider",
        "manage",
        "test/test_provider_idor_permissions.py",
        "provider stats route rejects foreign providers and ignores other users' operations",
        route_keys=(("GET", "/api/providers/{provider_id}/stats"),),
    ),
    CrossUserTestPolicy(
        "registration_invite",
        "manage",
        "test/test_admin_api_permissions.py",
        "non-admin invite email status route returns 403 before exposing delivery status",
        route_keys=(("GET", "/api/users/invites/email-status"),),
    ),
    CrossUserTestPolicy(
        "registration_invite",
        "manage",
        "test/test_admin_api_permissions.py",
        "non-admin invite list route returns 403 without listing invites",
        route_keys=(("GET", "/api/users/invites"),),
    ),
    CrossUserTestPolicy(
        "registration_invite",
        "manage",
        "test/test_admin_api_permissions.py",
        "non-admin invite create route returns 403 without creating invites",
        route_keys=(("POST", "/api/users/invites"),),
    ),
    CrossUserTestPolicy(
        "registration_invite",
        "manage",
        "test/test_admin_api_permissions.py",
        "non-admin invite resend route returns 403 without mutating invite rows",
        route_keys=(("POST", "/api/users/invites/{invite_id}/resend"),),
    ),
    CrossUserTestPolicy(
        "registration_invite",
        "manage",
        "test/test_admin_api_permissions.py",
        "non-admin invite delete route returns 403 without mutating invite rows",
        route_keys=(("DELETE", "/api/users/invites/{invite_id}"),),
    ),
    CrossUserTestPolicy(
        "session",
        "read",
        "test/test_auth_session_permissions.py",
        "auth/me requires authentication and returns only the resolved current user",
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill list route hides foreign user rows",
        route_keys=(("GET", "/api/native-agent/skills"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill private update route rejects foreign rows without mutation",
        route_keys=(("PATCH", "/api/native-agent/skills/{skill_id}"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill private publish route rejects foreign rows without mutation",
        route_keys=(("POST", "/api/native-agent/skills/{skill_id}/publish"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill private unpublish route rejects foreign rows without mutation",
        route_keys=(("POST", "/api/native-agent/skills/{skill_id}/unpublish"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill private delete route rejects foreign rows without mutation",
        route_keys=(("DELETE", "/api/native-agent/skills/{skill_id}"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill private download route rejects foreign rows",
        route_keys=(("GET", "/api/native-agent/skills/{skill_id}/download"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill private usage route rejects foreign rows",
        route_keys=(("GET", "/api/native-agent/skills/{skill_id}/usage"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill marketplace uninstall route rejects foreign installs without mutation",
        route_keys=(("DELETE", "/api/native-agent/skill-marketplace/{skill_id}/uninstall"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill marketplace clone-to-local route rejects foreign installs without mutation",
        route_keys=(("POST", "/api/native-agent/skill-marketplace/{skill_id}/clone-to-local"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill upload route assigns ownership to current user and does not trust body ownership",
        route_keys=(("POST", "/api/native-agent/skills"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_native_agent_private_idor_permissions.py",
        "skill recipe route assigns ownership to current user and does not trust source ownership",
        route_keys=(("POST", "/api/native-agent/skills/recipe"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_skill_marketplace_security.py",
        "skill marketplace catalog route rejects private-network catalog URLs",
        route_keys=(("GET", "/api/native-agent/skill-marketplace"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_skill_marketplace_security.py",
        "skill marketplace install route rejects private-network catalog URLs",
        route_keys=(("POST", "/api/native-agent/skill-marketplace/{skill_id}/install"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_skill_marketplace_security.py",
        "skill marketplace update route rejects private-network catalog URLs",
        route_keys=(("POST", "/api/native-agent/skill-marketplace/{skill_id}/update"),),
    ),
    CrossUserTestPolicy(
        "skill",
        "manage",
        "test/test_skill_marketplace_security.py",
        "skill marketplace clone route rejects private-network entry and readme URLs",
        route_keys=(("POST", "/api/native-agent/skill-marketplace/{skill_id}/clone-to-local"),),
    ),
    CrossUserTestPolicy(
        "spelling_preference",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "spelling dictionary route scopes learned words to current user",
        route_keys=(("GET", "/api/spelling/dictionary"),),
    ),
    CrossUserTestPolicy(
        "spelling_preference",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "spelling check route scopes learned words to current user",
        route_keys=(("POST", "/api/spelling/check"),),
    ),
    CrossUserTestPolicy(
        "spelling_preference",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "spelling suggestion route is authenticated and does not read user preferences",
        route_keys=(("POST", "/api/spelling/suggest"),),
    ),
    CrossUserTestPolicy(
        "spelling_preference",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "spelling learn route mutates only current user preferences",
        route_keys=(("POST", "/api/spelling/learn"),),
    ),
    CrossUserTestPolicy(
        "spelling_preference",
        "manage",
        "test/test_github_spelling_idor_permissions.py",
        "spelling unlearn route mutates only current user preferences",
        route_keys=(("POST", "/api/spelling/unlearn"),),
    ),
    CrossUserTestPolicy(
        "user",
        "admin",
        "test/test_admin_api_permissions.py",
        "non-admin user collection route returns 403",
        route_keys=(("GET", "/api/users"),),
    ),
    CrossUserTestPolicy(
        "user",
        "admin",
        "test/test_admin_api_permissions.py",
        "non-admin user patch route returns 403 without mutating admin user rows",
        route_keys=(("PATCH", "/api/users/{user_id}"),),
    ),
    CrossUserTestPolicy(
        "user",
        "admin",
        "test/test_admin_api_permissions.py",
        "non-admin user delete route returns 403 without mutating admin user rows",
        route_keys=(("DELETE", "/api/users/{user_id}"),),
    ),
    CrossUserTestPolicy(
        "workflow_definition",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow definition list route scopes to current user project",
        route_keys=(("GET", "/api/workflows/definitions"),),
    ),
    CrossUserTestPolicy(
        "workflow_definition",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow definition create route scopes to current user project",
        route_keys=(("POST", "/api/workflows/definitions"),),
    ),
    CrossUserTestPolicy(
        "workflow_definition",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow definition id read route hides foreign definitions",
        route_keys=(("GET", "/api/workflows/definitions/{definition_id}"),),
    ),
    CrossUserTestPolicy(
        "workflow_definition",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow definition update route hides foreign definitions without mutation",
        route_keys=(("PUT", "/api/workflows/definitions/{definition_id}"),),
    ),
    CrossUserTestPolicy(
        "workflow_definition",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow definition delete route hides foreign definitions without mutation",
        route_keys=(("DELETE", "/api/workflows/definitions/{definition_id}"),),
    ),
    CrossUserTestPolicy(
        "workflow_definition",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow definition execute routes hide foreign definitions and document refs",
        route_keys=(("POST", "/api/workflows/definitions/{definition_id}/execute"),),
    ),
    CrossUserTestPolicy(
        "workflow_run",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow run delete hides foreign runs without mutation",
    ),
    CrossUserTestPolicy(
        "workflow_run",
        "read",
        "test/test_workflow_idor_permissions.py",
        "workflow run list filters do not reveal foreign document or workflow runs",
        route_keys=(("GET", "/api/workflows/runs"),),
    ),
    CrossUserTestPolicy(
        "workflow_run",
        "read",
        "test/test_workflow_idor_permissions.py",
        "workflow run detail route does not reveal foreign document or workflow runs",
        route_keys=(("GET", "/api/workflows/runs/{run_id}"),),
    ),
    CrossUserTestPolicy(
        "workflow_test_case",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow test-case list route hides foreign definitions without mutation",
        route_keys=(("GET", "/api/workflows/definitions/{definition_id}/test-cases"),),
    ),
    CrossUserTestPolicy(
        "workflow_test_case",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow test-case create route hides foreign definitions without mutation",
        route_keys=(("POST", "/api/workflows/definitions/{definition_id}/test-cases"),),
    ),
    CrossUserTestPolicy(
        "workflow_test_case",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow test-case update route hides foreign definitions without mutation",
        route_keys=(("PUT", "/api/workflows/definitions/{definition_id}/test-cases/{case_id}"),),
    ),
    CrossUserTestPolicy(
        "workflow_test_case",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow test-case delete route hides foreign definitions without mutation",
        route_keys=(("DELETE", "/api/workflows/definitions/{definition_id}/test-cases/{case_id}"),),
    ),
    CrossUserTestPolicy(
        "workflow_test_case",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow test-case update route hides foreign cases under accessible definitions",
        route_keys=(("PUT", "/api/workflows/definitions/{definition_id}/test-cases/{case_id}"),),
    ),
    CrossUserTestPolicy(
        "workflow_test_case",
        "manage",
        "test/test_workflow_idor_permissions.py",
        "workflow test-case delete route hides foreign cases under accessible definitions",
        route_keys=(("DELETE", "/api/workflows/definitions/{definition_id}/test-cases/{case_id}"),),
    ),
)

_API_POLICY_INDEX: dict[RouteKey, ApiPolicy] = {policy.key: policy for policy in API_POLICIES}
_MCP_TRANSPORT_POLICY_INDEX: dict[RouteKey, McpTransportPolicy] = {
    policy.key: policy for policy in MCP_TRANSPORT_POLICIES
}
_AGENT_COMMAND_POLICY_INDEX: dict[str, AgentCommandPolicy] = {
    policy.name: policy for policy in AGENT_COMMAND_POLICIES
}
_IMPLICIT_FASTAPI_METHODS = {"HEAD", "OPTIONS"}
_SESSION_AUTH_DEPENDENCIES = {
    "get_current_user",
    "get_current_project",
    "get_project_from_path",
    "require_admin",
    "require_write_access",
}
_MCP_AUTH_DEPENDENCIES = {"get_mcp_auth"}
_API_WRITE_GATE_DEPENDENCIES = {"require_write_access", "require_admin"}
_API_ADMIN_GATE_DEPENDENCIES = {"require_admin"}
_API_WRITE_GATE_HELPER_TOKENS = (
    "ProjectMemberService.can_write",
    "accepted editor",
    "accepted owner/editor",
    "owner filter",
    "_require_owner",
    "require_admin",
    "AuthService.create_collab_token",
    "AuthService.verify_collab_token",
)
_API_OWNER_GATE_HELPER_TOKENS = (
    "owner filter",
    "_require_owner",
    "ProjectMemberService.get_role accepted owner",
    "require_admin",
)
_API_ADMIN_GATE_HELPER_TOKENS = ("require_admin",)
_API_AUTH_SURFACES = {
    "collab-token",
    "mcp-token",
    "public",
    "session",
    "session-or-collab-token",
}
_MCP_TRANSPORT_AUTH_SURFACES = {"mcp-token"}
_AGENT_COMMAND_AUTH_SURFACES = {"mcp-agent-command"}
_OWNERSHIP_MODEL_FIELDS = frozenset(
    {
        "agent_id",
        "annotation_id",
        "conversation_id",
        "created_by_user_id",
        "credential_id",
        "dataset_project_id",
        "definition_id",
        "doc_id",
        "notification_id",
        "owner_user_id",
        "project_id",
        "provider_id",
        "skill_id",
        "user_id",
    }
)


def iter_fastapi_route_keys(routes: Iterable[Any]) -> list[RouteKey]:
    """Extract explicit HTTP method/path keys from FastAPI/Starlette routes."""
    keys: list[RouteKey] = []
    for route in routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None)
        if not path or not methods:
            continue
        for method in sorted(methods):
            normalized = method.upper()
            if normalized in _IMPLICIT_FASTAPI_METHODS:
                continue
            keys.append((normalized, path))
    return keys


def _callable_name(callable_: Any) -> str:
    name = getattr(callable_, "__name__", "")
    if name:
        return name
    qualname = getattr(callable_, "__qualname__", "")
    if qualname:
        return qualname
    if callable_ is None:
        return ""
    return type(callable_).__name__


def iter_fastapi_route_dependency_names(route: Any) -> list[str]:
    """Extract recursive dependency callable names from a FastAPI route."""
    names: list[str] = []
    seen: set[int] = set()

    def walk(dependencies: Iterable[Any]) -> None:
        for dependency in dependencies:
            dependency_id = id(dependency)
            if dependency_id in seen:
                continue
            seen.add(dependency_id)

            name = _callable_name(getattr(dependency, "call", None))
            if name:
                names.append(name)

            nested = getattr(dependency, "dependencies", None) or ()
            walk(nested)

    dependant = getattr(route, "dependant", None)
    walk(getattr(dependant, "dependencies", None) or ())
    return names


def api_policy_keys(policies: Iterable[ApiPolicy] = API_POLICIES) -> set[RouteKey]:
    return {policy.key for policy in policies}


def mcp_transport_policy_keys(
    policies: Iterable[McpTransportPolicy] = MCP_TRANSPORT_POLICIES,
) -> set[RouteKey]:
    return {policy.key for policy in policies}


def agent_command_policy_names(
    policies: Iterable[AgentCommandPolicy] = AGENT_COMMAND_POLICIES,
) -> set[str]:
    return {policy.name for policy in policies}


def find_uncovered_api_policy_routes(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[ApiPolicy] = API_POLICIES,
) -> list[RouteKey]:
    """Return selected live routes that have no registered API policy."""
    registered = api_policy_keys(policies)
    missing = {
        key
        for key in iter_fastapi_route_keys(routes)
        if (include is None or include(*key)) and key not in registered
    }
    return sorted(missing, key=lambda key: (key[1], key[0]))


def find_stale_api_policies(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[ApiPolicy] = API_POLICIES,
) -> list[RouteKey]:
    """Return registered API policies that no longer match a live route."""
    live = set(iter_fastapi_route_keys(routes))
    stale = {
        policy.key
        for policy in policies
        if (include is None or include(*policy.key)) and policy.key not in live
    }
    return sorted(stale, key=lambda key: (key[1], key[0]))


def cross_user_test_policy_keys(
    coverage: Iterable[CrossUserTestPolicy] = CROSS_USER_TEST_POLICIES,
) -> set[ResourceActionKey]:
    return {policy.key for policy in coverage}


def find_uncovered_cross_user_test_policies(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[ApiPolicy] = API_POLICIES,
    coverage: Iterable[CrossUserTestPolicy] = CROSS_USER_TEST_POLICIES,
) -> list[str]:
    """Return selected API policies without indexed cross-user behavior-test evidence."""
    policy_by_key = {policy.key: policy for policy in policies}
    covered = cross_user_test_policy_keys(coverage)
    errors: list[str] = []

    for method, path in iter_fastapi_route_keys(routes):
        if include is not None and not include(method, path):
            continue
        policy = policy_by_key.get((method, path))
        if policy is None or policy.auth_surface == "public":
            continue
        if policy.expected_foreign_status not in {403, 404}:
            continue
        if (policy.resource, policy.action) not in covered:
            errors.append(
                "API "
                f"{method} {path} policy {policy.resource}.{policy.action} "
                "has no cross-user behavior test coverage"
            )

    return sorted(errors)


def build_api_route_cross_user_evidence_matrix(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[ApiPolicy] = API_POLICIES,
    coverage: Iterable[CrossUserTestPolicy] = CROSS_USER_TEST_POLICIES,
) -> list[ApiRouteCrossUserEvidence]:
    """Materialize route-level behavior evidence from sparse policy registries."""
    policy_by_key = {policy.key: policy for policy in policies}
    coverage_by_key: dict[ResourceActionKey, list[CrossUserTestPolicy]] = {}
    for policy in coverage:
        coverage_by_key.setdefault(policy.key, []).append(policy)

    entries: list[ApiRouteCrossUserEvidence] = []
    for method, path in iter_fastapi_route_keys(routes):
        if include is not None and not include(method, path):
            continue
        api_policy = policy_by_key.get((method, path))
        if api_policy is None or api_policy.auth_surface == "public":
            continue
        if api_policy.expected_foreign_status not in {403, 404}:
            continue

        route_key = (method, path)
        for evidence_policy in coverage_by_key.get((api_policy.resource, api_policy.action), []):
            scoped_route_keys = evidence_policy.normalized_route_keys
            if scoped_route_keys and route_key not in scoped_route_keys:
                continue
            entries.append(
                ApiRouteCrossUserEvidence(
                    method=method,
                    path=path,
                    resource=api_policy.resource,
                    action=api_policy.action,
                    auth_surface=api_policy.auth_surface,
                    expected_foreign_status=api_policy.expected_foreign_status,
                    test_module=evidence_policy.test_module,
                    evidence=evidence_policy.evidence,
                )
            )

    return sorted(
        entries,
        key=lambda entry: (
            entry.path,
            entry.method,
            entry.test_module,
            entry.resource,
            entry.action,
        ),
    )


def build_cross_user_route_fanout_report(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[ApiPolicy] = API_POLICIES,
    coverage: Iterable[CrossUserTestPolicy] = CROSS_USER_TEST_POLICIES,
) -> list[CrossUserRouteFanout]:
    """Summarize how many live API routes each sparse cross-user evidence row covers."""
    grouped: dict[tuple[str, str, str, str], set[RouteKey]] = {}
    for entry in build_api_route_cross_user_evidence_matrix(
        routes,
        include=include,
        policies=policies,
        coverage=coverage,
    ):
        grouped.setdefault(
            (entry.resource, entry.action, entry.test_module, entry.evidence),
            set(),
        ).add((entry.method, entry.path))

    report = [
        CrossUserRouteFanout(
            resource=resource,
            action=action,
            test_module=test_module,
            evidence=evidence,
            route_count=len(route_keys),
            routes=tuple(sorted(route_keys, key=lambda key: (key[1], key[0]))),
        )
        for (resource, action, test_module, evidence), route_keys in grouped.items()
    ]
    return sorted(
        report,
        key=lambda entry: (
            -entry.route_count,
            entry.resource,
            entry.action,
            entry.test_module,
            entry.evidence,
        ),
    )


def find_stale_cross_user_test_policies(
    *,
    policies: Iterable[ApiPolicy] = API_POLICIES,
    coverage: Iterable[CrossUserTestPolicy] = CROSS_USER_TEST_POLICIES,
) -> list[str]:
    """Return coverage entries whose resource/action no longer appears in API policies."""
    api_policy_by_key = {policy.key: policy for policy in policies}
    api_resource_actions = {(policy.resource, policy.action) for policy in api_policy_by_key.values()}
    errors: list[str] = []

    for policy in coverage:
        if policy.key not in api_resource_actions:
            errors.append(f"cross-user coverage {policy.resource}.{policy.action} references no API policy")
        for route_key in policy.normalized_route_keys:
            api_policy = api_policy_by_key.get(route_key)
            method, path = route_key
            if api_policy is None:
                errors.append(
                    "cross-user coverage "
                    f"{policy.resource}.{policy.action} route {method} {path} references no API policy"
                )
            elif (api_policy.resource, api_policy.action) != policy.key:
                errors.append(
                    "cross-user coverage "
                    f"{policy.resource}.{policy.action} route {method} {path} maps to API policy "
                    f"{api_policy.resource}.{api_policy.action}"
                )
    return sorted(errors)


def find_missing_cross_user_test_files(
    test_root: Path | str,
    *,
    coverage: Iterable[CrossUserTestPolicy] = CROSS_USER_TEST_POLICIES,
) -> list[str]:
    """Return coverage entries that point at missing test files."""
    root = Path(test_root)
    errors = [
        f"cross-user coverage {policy.resource}.{policy.action} "
        f"references missing test file {policy.test_module}"
        for policy in coverage
        if not (root / policy.test_module).is_file()
    ]
    return sorted(errors)


def mcp_transport_test_policy_keys(
    coverage: Iterable[McpTransportTestPolicy] = MCP_TRANSPORT_TEST_POLICIES,
) -> set[RouteKey]:
    return {policy.key for policy in coverage}


def find_uncovered_mcp_transport_test_policies(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[McpTransportPolicy] = MCP_TRANSPORT_POLICIES,
    coverage: Iterable[McpTransportTestPolicy] = MCP_TRANSPORT_TEST_POLICIES,
) -> list[str]:
    """Return MCP transport policies without indexed behavior-test evidence."""
    policy_by_key = {policy.key: policy for policy in policies}
    covered = mcp_transport_test_policy_keys(coverage)
    errors: list[str] = []

    for method, path in iter_fastapi_route_keys(routes):
        if include is not None and not include(method, path):
            continue
        if (method, path) not in policy_by_key:
            continue
        if (method, path) not in covered:
            errors.append(f"MCP transport {method} {path} has no behavior test coverage")

    return sorted(errors)


def find_stale_mcp_transport_test_policies(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[McpTransportPolicy] = MCP_TRANSPORT_POLICIES,
    coverage: Iterable[McpTransportTestPolicy] = MCP_TRANSPORT_TEST_POLICIES,
) -> list[str]:
    """Return MCP transport test coverage entries that no longer map to live policies."""
    live_route_keys = {
        key for key in iter_fastapi_route_keys(routes) if include is None or include(*key)
    }
    policy_keys = {
        policy.key
        for policy in policies
        if (include is None or include(*policy.key)) and policy.key in live_route_keys
    }
    errors = [
        f"MCP transport coverage {policy.method.upper()} {policy.path} references no transport policy"
        for policy in coverage
        if (include is None or include(*policy.key)) and policy.key not in policy_keys
    ]
    return sorted(errors)


def find_missing_mcp_transport_test_files(
    test_root: Path | str,
    *,
    coverage: Iterable[McpTransportTestPolicy] = MCP_TRANSPORT_TEST_POLICIES,
) -> list[str]:
    """Return MCP transport coverage entries that point at missing test files."""
    root = Path(test_root)
    errors = [
        f"MCP transport coverage {policy.method.upper()} {policy.path} "
        f"references missing test file {policy.test_module}"
        for policy in coverage
        if not (root / policy.test_module).is_file()
    ]
    return sorted(errors)


def agent_command_test_policy_names(
    coverage: Iterable[AgentCommandTestPolicy] = AGENT_COMMAND_TEST_POLICIES,
) -> set[str]:
    return {policy.name for policy in coverage}


def find_uncovered_agent_command_test_policies(
    command_names: Iterable[str],
    *,
    coverage: Iterable[AgentCommandTestPolicy] = AGENT_COMMAND_TEST_POLICIES,
) -> list[str]:
    """Return Agent Command tools without indexed behavior-test evidence."""
    covered = agent_command_test_policy_names(coverage)
    errors = [
        f"Agent Command {name} has no behavior test coverage"
        for name in command_names
        if name not in covered
    ]
    return sorted(errors)


def find_stale_agent_command_test_policies(
    command_names: Iterable[str],
    *,
    coverage: Iterable[AgentCommandTestPolicy] = AGENT_COMMAND_TEST_POLICIES,
) -> list[str]:
    """Return Agent Command test coverage entries that no longer map to live tools."""
    live = set(command_names)
    errors = [
        f"Agent Command coverage {policy.name} references no registered command"
        for policy in coverage
        if policy.name not in live
    ]
    return sorted(errors)


def find_missing_agent_command_test_files(
    test_root: Path | str,
    *,
    coverage: Iterable[AgentCommandTestPolicy] = AGENT_COMMAND_TEST_POLICIES,
) -> list[str]:
    """Return Agent Command coverage entries that point at missing test files."""
    root = Path(test_root)
    errors = [
        f"Agent Command coverage {policy.name} references missing test file {policy.test_module}"
        for policy in coverage
        if not (root / policy.test_module).is_file()
    ]
    return sorted(errors)


def build_mcp_transport_evidence_matrix(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[McpTransportPolicy] = MCP_TRANSPORT_POLICIES,
    coverage: Iterable[McpTransportTestPolicy] = MCP_TRANSPORT_TEST_POLICIES,
) -> list[McpTransportEvidence]:
    """Materialize MCP transport behavior evidence from live routes and sparse registries."""
    policy_by_key = {policy.key: policy for policy in policies}
    coverage_by_key: dict[RouteKey, list[McpTransportTestPolicy]] = {}
    for policy in coverage:
        coverage_by_key.setdefault(policy.key, []).append(policy)

    entries: list[McpTransportEvidence] = []
    for method, path in iter_fastapi_route_keys(routes):
        if include is not None and not include(method, path):
            continue
        transport_policy = policy_by_key.get((method, path))
        if transport_policy is None:
            continue
        for evidence_policy in coverage_by_key.get((method, path), []):
            entries.append(
                McpTransportEvidence(
                    method=method,
                    path=path,
                    auth_surface=transport_policy.auth_surface,
                    test_module=evidence_policy.test_module,
                    evidence=evidence_policy.evidence,
                )
            )

    return sorted(
        entries,
        key=lambda entry: (
            entry.path,
            entry.method,
            entry.test_module,
            entry.evidence,
        ),
    )


def build_agent_command_evidence_matrix(
    command_names: Iterable[str],
    *,
    policies: Iterable[AgentCommandPolicy] = AGENT_COMMAND_POLICIES,
    coverage: Iterable[AgentCommandTestPolicy] = AGENT_COMMAND_TEST_POLICIES,
) -> list[AgentCommandEvidence]:
    """Materialize Agent Command behavior evidence from live tools and sparse registries."""
    live_command_names = set(command_names)
    policy_by_name = {policy.name: policy for policy in policies}
    coverage_by_name: dict[str, list[AgentCommandTestPolicy]] = {}
    for policy in coverage:
        coverage_by_name.setdefault(policy.name, []).append(policy)

    entries: list[AgentCommandEvidence] = []
    for name in sorted(live_command_names):
        command_policy = policy_by_name.get(name)
        if command_policy is None:
            continue
        for evidence_policy in coverage_by_name.get(name, []):
            entries.append(
                AgentCommandEvidence(
                    name=name,
                    resource=command_policy.resource,
                    action=command_policy.action,
                    auth_surface=command_policy.auth_surface,
                    expected_foreign_status=command_policy.expected_foreign_status,
                    test_module=evidence_policy.test_module,
                    evidence=evidence_policy.evidence,
                )
            )

    return sorted(
        entries,
        key=lambda entry: (
            entry.name,
            entry.test_module,
            entry.evidence,
        ),
    )


def find_uncovered_mcp_transport_policy_routes(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[McpTransportPolicy] = MCP_TRANSPORT_POLICIES,
) -> list[RouteKey]:
    """Return selected live MCP transport routes without registered policy."""
    registered = mcp_transport_policy_keys(policies)
    missing = {
        key
        for key in iter_fastapi_route_keys(routes)
        if (include is None or include(*key)) and key not in registered
    }
    return sorted(missing, key=lambda key: (key[1], key[0]))


def find_stale_mcp_transport_policies(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[McpTransportPolicy] = MCP_TRANSPORT_POLICIES,
) -> list[RouteKey]:
    """Return MCP transport policies that no longer match a live route."""
    live = set(iter_fastapi_route_keys(routes))
    stale = {
        policy.key
        for policy in policies
        if (include is None or include(*policy.key)) and policy.key not in live
    }
    return sorted(stale, key=lambda key: (key[1], key[0]))


def find_mcp_transport_auth_surface_mismatches(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[McpTransportPolicy] = MCP_TRANSPORT_POLICIES,
) -> list[str]:
    """Return MCP transport policies whose auth surface drifts from route dependencies."""
    policy_by_key = {policy.key: policy for policy in policies}
    errors: list[str] = []

    for route in routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None)
        if not path or not methods:
            continue

        dependency_name_set = set(iter_fastapi_route_dependency_names(route))

        for method in sorted(methods):
            normalized = method.upper()
            if normalized in _IMPLICIT_FASTAPI_METHODS:
                continue
            if include is not None and not include(normalized, path):
                continue

            policy = policy_by_key.get((normalized, path))
            if policy is None:
                continue

            if policy.auth_surface == "mcp-token" and not (dependency_name_set & _MCP_AUTH_DEPENDENCIES):
                errors.append(
                    "MCP transport "
                    f"{normalized} {path} declares mcp-token auth surface but route "
                    "dependencies do not include get_mcp_auth"
                )

    return errors


def find_api_auth_surface_mismatches(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[ApiPolicy] = API_POLICIES,
    actions: Mapping[tuple[str, str], ActionPolicy] | Iterable[ActionPolicy] = ACTION_POLICIES,
) -> list[str]:
    """Return API policies whose declared auth surface drifts from route dependencies."""
    policy_by_key = {policy.key: policy for policy in policies}
    if isinstance(actions, Mapping):
        action_by_key = dict(actions)
    else:
        action_by_key = {(policy.resource, policy.action): policy for policy in actions}
    errors: list[str] = []

    for route in routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None)
        if not path or not methods:
            continue

        dependency_names = iter_fastapi_route_dependency_names(route)
        dependency_name_set = set(dependency_names)
        authenticated_dependencies = dependency_name_set & (
            _SESSION_AUTH_DEPENDENCIES | _MCP_AUTH_DEPENDENCIES
        )

        for method in sorted(methods):
            normalized = method.upper()
            if normalized in _IMPLICIT_FASTAPI_METHODS:
                continue
            if include is not None and not include(normalized, path):
                continue

            policy = policy_by_key.get((normalized, path))
            if policy is None:
                continue

            action_policy = action_by_key.get((policy.resource, policy.action))

            if policy.auth_surface == "public":
                if authenticated_dependencies:
                    first_dependency = sorted(authenticated_dependencies)[0]
                    errors.append(
                        "API "
                        f"{normalized} {path} declares public auth surface but route "
                        "dependencies include authenticated dependency "
                        f"{first_dependency}"
                    )

            elif policy.auth_surface == "session":
                if not (dependency_name_set & _SESSION_AUTH_DEPENDENCIES):
                    errors.append(
                        "API "
                        f"{normalized} {path} declares session auth surface but route "
                        "dependencies do not include a session auth dependency"
                    )

            elif policy.auth_surface == "mcp-token" and not (dependency_name_set & _MCP_AUTH_DEPENDENCIES):
                errors.append(
                    "API "
                    f"{normalized} {path} declares mcp-token auth surface but route "
                    "dependencies do not include get_mcp_auth"
                )

            if (
                action_policy is not None
                and action_policy.required is Authority.SITE_ADMIN
                and "require_admin" not in dependency_name_set
            ):
                errors.append(
                    "API "
                    f"{normalized} {path} declares site-admin action "
                    f"{policy.resource}.{policy.action} but route dependencies do not include require_admin"
                )

    return errors


def find_api_authority_gate_mismatches(
    routes: Iterable[Any],
    *,
    include: RouteFilter | None = None,
    policies: Iterable[ApiPolicy] = API_POLICIES,
    actions: Mapping[tuple[str, str], ActionPolicy] | Iterable[ActionPolicy] = ACTION_POLICIES,
) -> list[str]:
    """Return high-authority API policies missing runtime or documented helper gates."""
    policy_by_key = {policy.key: policy for policy in policies}
    if isinstance(actions, Mapping):
        action_by_key = dict(actions)
    else:
        action_by_key = {(policy.resource, policy.action): policy for policy in actions}

    errors: list[str] = []
    for route in routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None)
        if not path or not methods:
            continue

        dependency_name_set = set(iter_fastapi_route_dependency_names(route))

        for method in sorted(methods):
            normalized = method.upper()
            if normalized in _IMPLICIT_FASTAPI_METHODS:
                continue
            if include is not None and not include(normalized, path):
                continue

            policy = policy_by_key.get((normalized, path))
            if policy is None:
                continue

            action_policy = action_by_key.get((policy.resource, policy.action))
            if action_policy is None:
                continue

            required = action_policy.required
            helper = f"{policy.helper} {action_policy.helper}"

            if required is Authority.SITE_ADMIN:
                if not (
                    dependency_name_set & _API_ADMIN_GATE_DEPENDENCIES
                    or any(token in helper for token in _API_ADMIN_GATE_HELPER_TOKENS)
                ):
                    errors.append(
                        "API "
                        f"{normalized} {path} declares site-admin action "
                        f"{policy.resource}.{policy.action} but route dependencies/helper "
                        "do not name an admin gate"
                    )

            elif required is Authority.PROJECT_OWNER:
                if not (
                    dependency_name_set & _API_ADMIN_GATE_DEPENDENCIES
                    or any(token in helper for token in _API_OWNER_GATE_HELPER_TOKENS)
                ):
                    errors.append(
                        "API "
                        f"{normalized} {path} declares project_owner action "
                        f"{policy.resource}.{policy.action} but route dependencies/helper "
                        "do not name an owner gate"
                    )

            elif required is Authority.PROJECT_WRITE:
                if not (
                    dependency_name_set & _API_WRITE_GATE_DEPENDENCIES
                    or any(token in helper for token in _API_WRITE_GATE_HELPER_TOKENS)
                ):
                    errors.append(
                        "API "
                        f"{normalized} {path} declares project_write action "
                        f"{policy.resource}.{policy.action} but route dependencies/helper "
                        "do not name a write/owner gate"
                    )

    return errors


def find_uncovered_agent_command_policies(
    command_names: Iterable[str],
    *,
    policies: Iterable[AgentCommandPolicy] = AGENT_COMMAND_POLICIES,
) -> list[str]:
    registered = agent_command_policy_names(policies)
    missing = {name for name in command_names if name not in registered}
    return sorted(missing)


def find_stale_agent_command_policies(
    command_names: Iterable[str],
    *,
    policies: Iterable[AgentCommandPolicy] = AGENT_COMMAND_POLICIES,
) -> list[str]:
    live = set(command_names)
    stale = {policy.name for policy in policies if policy.name not in live}
    return sorted(stale)


def _agent_command_requires_write_scope(required: Authority) -> bool:
    return required in {
        Authority.PROJECT_WRITE,
        Authority.PROJECT_OWNER,
        Authority.SITE_ADMIN,
    }


def find_agent_command_manifest_mismatches(
    tools: Iterable[Mapping[str, Any]],
    *,
    policies: Iterable[AgentCommandPolicy] = AGENT_COMMAND_POLICIES,
    actions: Mapping[tuple[str, str], ActionPolicy] | Iterable[ActionPolicy] = ACTION_POLICIES,
) -> list[str]:
    """Return Agent Command policy drift against the shared MCP tool manifest."""
    policy_by_name = {policy.name: policy for policy in policies}
    if isinstance(actions, Mapping):
        action_by_key = dict(actions)
    else:
        action_by_key = {(policy.resource, policy.action): policy for policy in actions}

    errors: list[str] = []
    for tool in tools:
        name = str(tool.get("name") or "")
        policy = policy_by_name.get(name)
        if policy is None:
            continue

        action_policy = action_by_key.get((policy.resource, policy.action))
        if action_policy is None:
            continue

        annotations = tool.get("annotations")
        if not isinstance(annotations, Mapping):
            annotations = {}
        meta = tool.get("_meta")
        if not isinstance(meta, Mapping):
            meta = {}
        superleaf_meta = meta.get("superleaf")
        if not isinstance(superleaf_meta, Mapping):
            superleaf_meta = {}

        manifest_scope = superleaf_meta.get("requiresScope")
        read_only_hint = annotations.get("readOnlyHint")
        if _agent_command_requires_write_scope(action_policy.required):
            if manifest_scope != "write":
                errors.append(
                    f"Agent Command {name} requires {action_policy.required.value} "
                    f"but manifest requiresScope is {manifest_scope}"
                )
            if read_only_hint is True:
                errors.append(
                    f"Agent Command {name} requires {action_policy.required.value} "
                    "but manifest readOnlyHint is true"
                )
        elif manifest_scope == "write":
            errors.append(
                f"Agent Command {name} manifest requiresScope is write "
                f"but policy requires {action_policy.required.value}"
            )

    return errors


def get_resource_policy(resource: str) -> ResourcePolicy:
    return RESOURCE_POLICIES[resource]


def get_action_policy(resource: str, action: str) -> ActionPolicy:
    return ACTION_POLICIES[(resource, action)]


def get_agent_command_policy(name: str) -> AgentCommandPolicy:
    return _AGENT_COMMAND_POLICY_INDEX[name]


def get_api_policy(method: str, path: str) -> ApiPolicy:
    return _API_POLICY_INDEX[(method.upper(), path)]


def _resolve_model_class(model_name: str) -> type[Any] | None:
    from .. import models

    candidate = getattr(models, model_name, None)
    if isinstance(candidate, type) and hasattr(candidate, "__table__"):
        return candidate
    return None


def _model_has_field(model_cls: type[Any], field_name: str) -> bool:
    mapper = getattr(model_cls, "__mapper__", None)
    if mapper is not None and field_name in mapper.attrs:
        return True
    return hasattr(model_cls, field_name)


def find_unregistered_ownership_models(
    *,
    resources: Mapping[str, ResourcePolicy] = RESOURCE_POLICIES,
    ownership_fields: Iterable[str] = _OWNERSHIP_MODEL_FIELDS,
) -> list[str]:
    """Return SQLAlchemy models with ownership-like fields but no resource row."""
    from .. import models

    registered_models = {policy.model for policy in resources.values() if policy.model}
    ownership_field_set = set(ownership_fields)
    errors: list[str] = []

    for model_name, candidate in sorted(vars(models).items()):
        if not isinstance(candidate, type) or not hasattr(candidate, "__table__"):
            continue
        fields = {column.name for column in candidate.__table__.columns}
        matched_fields = sorted(fields & ownership_field_set)
        if matched_fields and model_name not in registered_models:
            errors.append(
                f"model {model_name} has ownership fields "
                f"{', '.join(matched_fields)} but no resource policy"
            )

    return errors


def validate_policy_registry(
    *,
    resources: Mapping[str, ResourcePolicy] = RESOURCE_POLICIES,
    actions: Mapping[tuple[str, str], ActionPolicy] | Iterable[ActionPolicy] = _ACTION_POLICY_DEFINITIONS,
    api_policies: Iterable[ApiPolicy] = API_POLICIES,
    mcp_transport_policies: Iterable[McpTransportPolicy] = MCP_TRANSPORT_POLICIES,
    agent_command_policies: Iterable[AgentCommandPolicy] = AGENT_COMMAND_POLICIES,
) -> list[str]:
    errors: list[str] = []

    for key, policy in resources.items():
        if key != policy.key:
            errors.append(f"resource key mismatch: {key} != {policy.key}")
        if policy.parent_resource and policy.parent_resource not in resources:
            errors.append(f"resource {key} references unknown parent {policy.parent_resource}")
        if policy.parent_field and not policy.parent_resource:
            errors.append(f"resource {key} parent_field {policy.parent_field} requires parent_resource")
        if policy.parent_resource and not policy.parent_field:
            errors.append(f"resource {key} parent_resource {policy.parent_resource} requires parent_field")
        if policy.boundary is OwnershipBoundary.NO_DIRECT_ACCESS and policy.direct_api_lookup:
            errors.append(f"resource {key} is no-direct-access but allows direct lookup")
        if policy.model:
            if (
                policy.boundary
                in {
                    OwnershipBoundary.USER_PRIVATE,
                    OwnershipBoundary.PROJECT_MEMBERSHIP,
                    OwnershipBoundary.PROJECT_OWNER,
                }
                and not policy.owner_field
                and not policy.parent_resource
            ):
                errors.append(
                    f"resource {key} boundary {policy.boundary.value} "
                    "requires owner_field or parent_resource"
                )
            model_cls = _resolve_model_class(policy.model)
            if model_cls is None:
                errors.append(f"resource {key} references unknown model {policy.model}")
            else:
                if policy.owner_field and not _model_has_field(model_cls, policy.owner_field):
                    errors.append(
                        f"resource {key} owner_field {policy.model}.{policy.owner_field} does not exist"
                    )
                if policy.parent_field and not _model_has_field(model_cls, policy.parent_field):
                    errors.append(
                        f"resource {key} parent_field {policy.model}.{policy.parent_field} does not exist"
                    )
    errors.extend(find_unregistered_ownership_models(resources=resources))

    if isinstance(actions, Mapping):
        action_items = list(actions.items())
    else:
        action_items = [((policy.resource, policy.action), policy) for policy in actions]

    actions_by_key: dict[tuple[str, str], ActionPolicy] = {}
    seen_action_keys: set[tuple[str, str]] = set()
    for (resource, action), policy in action_items:
        if (resource, action) in seen_action_keys:
            errors.append(f"duplicate action policy {resource}.{action}")
        seen_action_keys.add((resource, action))
        actions_by_key[(resource, action)] = policy
        if resource not in resources:
            errors.append(f"action {resource}.{action} references unknown resource")
        if (resource, action) != (policy.resource, policy.action):
            errors.append(f"action key mismatch: {resource}.{action}")
        if not policy.helper:
            errors.append(f"action {resource}.{action} has no helper")

    seen_api_keys: set[tuple[str, str]] = set()
    for policy in api_policies:
        if policy.key in seen_api_keys:
            errors.append(f"duplicate API policy {policy.method} {policy.path}")
        seen_api_keys.add(policy.key)
        if policy.resource not in resources:
            errors.append(f"API {policy.method} {policy.path} references unknown resource")
        action_policy = actions_by_key.get((policy.resource, policy.action))
        if action_policy is None:
            errors.append(
                "API "
                f"{policy.method} {policy.path} references unknown action "
                f"{policy.resource}.{policy.action}"
            )
        elif (
            policy.expected_foreign_status != action_policy.expected_foreign_status
            and not policy.notes.strip()
        ):
            errors.append(
                "API "
                f"{policy.method} {policy.path} expected_foreign_status "
                f"{policy.expected_foreign_status} differs from action "
                f"{policy.resource}.{policy.action} "
                f"{action_policy.expected_foreign_status} without notes"
            )
        api_auth_surface = policy.auth_surface.strip()
        if not api_auth_surface:
            errors.append(f"API {policy.method} {policy.path} has no auth surface")
        elif api_auth_surface not in _API_AUTH_SURFACES:
            errors.append(f"API {policy.method} {policy.path} has unknown auth surface {policy.auth_surface}")
        elif (
            api_auth_surface == "public"
            and action_policy is not None
            and action_policy.required is not Authority.NONE
        ):
            errors.append(
                "API "
                f"{policy.method} {policy.path} declares public auth surface "
                f"for action {policy.resource}.{policy.action} requiring "
                f"{action_policy.required.value}"
            )
        if not policy.helper:
            errors.append(f"API {policy.method} {policy.path} has no helper")

    seen_mcp_transport_keys: set[tuple[str, str]] = set()
    for policy in mcp_transport_policies:
        if policy.key in seen_mcp_transport_keys:
            errors.append(f"duplicate MCP transport policy {policy.method} {policy.path}")
        seen_mcp_transport_keys.add(policy.key)
        mcp_auth_surface = policy.auth_surface.strip()
        if not mcp_auth_surface:
            errors.append(f"MCP transport {policy.method} {policy.path} has no auth surface")
        elif mcp_auth_surface not in _MCP_TRANSPORT_AUTH_SURFACES:
            errors.append(
                f"MCP transport {policy.method} {policy.path} has unknown auth surface {policy.auth_surface}"
            )
        if not policy.helper:
            errors.append(f"MCP transport {policy.method} {policy.path} has no helper")

    seen_command_names: set[str] = set()
    for policy in agent_command_policies:
        if policy.name in seen_command_names:
            errors.append(f"duplicate Agent Command policy {policy.name}")
        seen_command_names.add(policy.name)
        if not policy.name:
            errors.append("Agent Command policy has empty name")
        if policy.resource not in resources:
            errors.append(f"Agent Command {policy.name} references unknown resource")
        if (policy.resource, policy.action) not in actions_by_key:
            errors.append(
                f"Agent Command {policy.name} references unknown action {policy.resource}.{policy.action}"
            )
        agent_auth_surface = policy.auth_surface.strip()
        if not agent_auth_surface:
            errors.append(f"Agent Command {policy.name} has no auth surface")
        elif agent_auth_surface not in _AGENT_COMMAND_AUTH_SURFACES:
            errors.append(f"Agent Command {policy.name} has unknown auth surface {policy.auth_surface}")
        if not policy.helper:
            errors.append(f"Agent Command {policy.name} has no helper")

    return errors

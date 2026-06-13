/**
 * 项目归档绑定与快照相关 API。
 */

import { http } from './client'
import type { GitHubImportResult, GitHubPushResult } from './github'

export interface ProjectArchiveBinding {
  project_id: string
  local_repo_path: string
  github_account_id: string
  github_repo_url: string
  github_owner: string
  github_repo: string
  github_branch: string
  github_path: string
  github_private_required: boolean
  github_bound_at: string | null
  last_local_commit_sha: string
  last_pushed_commit_sha: string
}

export interface ProjectArchiveSnapshot {
  id: string
  project_id: string
  commit_sha: string
  message: string
  doc_count: number
  file_count: number
  byte_count: number
  pushed_to_github: boolean
  created_at: string
}

export interface ProjectArchiveStatus {
  binding: ProjectArchiveBinding
  snapshots: ProjectArchiveSnapshot[]
  local_dirty: boolean
  remote_configured: boolean
}

export interface ProjectArchiveBindingDraft {
  github_repo_url?: string
  github_owner: string
  github_repo: string
  github_branch: string
  github_path?: string
  github_private_required: boolean
}

export const projectArchiveApi = {
  status: (projectId: string) =>
    http<ProjectArchiveStatus>(`/api/projects/${encodeURIComponent(projectId)}/archive/status`, {
      scope: 'global',
    }),
  configureGithub: (projectId: string, draft: ProjectArchiveBindingDraft) =>
    http<ProjectArchiveBinding>(`/api/projects/${encodeURIComponent(projectId)}/archive/github`, {
      method: 'PUT',
      body: JSON.stringify(draft),
      scope: 'global',
    }),
  createSnapshot: (projectId: string, message?: string) =>
    http<ProjectArchiveSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/archive/snapshots`, {
      method: 'POST',
      body: JSON.stringify({ message }),
      scope: 'global',
    }),
  listSnapshots: (projectId: string) =>
    http<ProjectArchiveSnapshot[]>(`/api/projects/${encodeURIComponent(projectId)}/archive/snapshots`, {
      scope: 'global',
    }),
  importGithub: (projectId: string, repoUrl: string, branch?: string) =>
    http<GitHubImportResult>(`/api/projects/${encodeURIComponent(projectId)}/archive/github/import`, {
      method: 'POST',
      body: JSON.stringify({ repo_url: repoUrl, branch: branch || null }),
      scope: 'global',
    }),
  pushGithub: (projectId: string, message?: string) =>
    http<GitHubPushResult>(`/api/projects/${encodeURIComponent(projectId)}/archive/github/push`, {
      method: 'POST',
      body: JSON.stringify({ message }),
      scope: 'global',
    }),
}

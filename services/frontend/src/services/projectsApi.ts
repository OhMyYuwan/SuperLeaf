/**
 * projectsApi — CRUD for /api/projects.
 *
 * All calls go through the shared `http` helper but with `scope: 'global'` so
 * the `X-Project-Id` header is NOT injected. The project list endpoint must
 * be reachable before a project is selected (chicken-and-egg).
 */

import { http } from './backendApi'
import type { Skill } from './backendApi'

export interface ProjectSummary {
  id: string
  user_id: string
  name: string
  main_doc_id: string
  compiler: string
  project_type: 'paper' | 'skill' | 'data' | string
  is_skill_project: boolean
  project_skill_id: string
  skill_cache_version: number
  skill_cache_updated_at: string | null
  created_at: string
  updated_at: string
  my_role: 'owner' | 'editor' | 'viewer'
}

export interface ProjectCreate {
  name: string
  project_type?: 'paper' | 'skill' | 'data'
}

export interface GitHubProjectImport {
  repo_url: string
  branch?: string
  name?: string
}

export interface ProjectUpdate {
  name?: string
  main_doc_id?: string
  compiler?: string
  is_skill_project?: boolean
  project_type?: 'paper' | 'skill' | 'data'
}

export interface ProjectSkillCacheResult {
  project: ProjectSummary
  skill: Skill
}

export type ProjectSkillDataStatus = 'submitted' | 'all' | 'pending' | 'in_review' | 'labeled' | 'discarded'

export interface ProjectSkillDataPackageResult {
  dataset_project_id: string
  dataset_name: string
  status_filter: ProjectSkillDataStatus
  record_count: number
  folder: string
  files: Array<{
    path: string
    kind: string
    size_bytes: number
  }>
  generated_at: string
}

export interface ProjectSkillDataClearResult {
  folder: string
  deleted_count: number
}

export const projectsApi = {
  list: () => http<ProjectSummary[]>('/api/projects', { scope: 'global' }),
  get: (id: string) =>
    http<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}`, { scope: 'global' }),
  create: (body: ProjectCreate) =>
    http<ProjectSummary>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
      scope: 'global',
    }),
  importGithub: (body: GitHubProjectImport) =>
    http<ProjectSummary>('/api/projects/import/github', {
      method: 'POST',
      body: JSON.stringify({
        repo_url: body.repo_url,
        branch: body.branch || null,
        name: body.name || null,
      }),
      scope: 'global',
    }),
  update: (id: string, body: ProjectUpdate) =>
    http<ProjectSummary>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      scope: 'global',
    }),
  updateSkillCache: (id: string) =>
    http<ProjectSkillCacheResult>(`/api/projects/${encodeURIComponent(id)}/skill-cache`, {
      method: 'POST',
      scope: 'global',
    }),
  attachSkillDataPackage: (
    id: string,
    body: { data_project_id: string; status?: ProjectSkillDataStatus },
  ) =>
    http<ProjectSkillDataPackageResult>(
      `/api/projects/${encodeURIComponent(id)}/skill-data/from-dataset`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        scope: 'global',
      },
    ),
  clearSkillDataPackage: (id: string, dataProjectId?: string) => {
    const query = dataProjectId ? `?data_project_id=${encodeURIComponent(dataProjectId)}` : ''
    return http<ProjectSkillDataClearResult>(
      `/api/projects/${encodeURIComponent(id)}/skill-data${query}`,
      {
        method: 'DELETE',
        scope: 'global',
      },
    )
  },
  remove: (id: string) =>
    http<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      scope: 'global',
    }),
}

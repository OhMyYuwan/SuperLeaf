/**
 * projectsApi — CRUD for /api/projects.
 *
 * All calls go through the shared `http` helper but with `scope: 'global'` so
 * the `X-Project-Id` header is NOT injected. The project list endpoint must
 * be reachable before a project is selected (chicken-and-egg).
 */

import { http } from './backendApi'

export interface ProjectSummary {
  id: string
  user_id: string
  name: string
  main_doc_id: string
  compiler: string
  created_at: string
  updated_at: string
  my_role: 'owner' | 'editor' | 'viewer'
}

export interface ProjectCreate {
  name: string
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
  remove: (id: string) =>
    http<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      scope: 'global',
    }),
}

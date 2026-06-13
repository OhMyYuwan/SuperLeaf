/**
 * 项目成员与最近协作者相关 API。
 */

import { http } from './client'

export interface ProjectMember {
  id: string
  project_id: string
  user_id: string
  user_email: string
  user_display_name: string
  role: 'editor' | 'viewer'
  status: string
  created_at: string
}

export interface ProjectMemberAddIn {
  email: string
  role?: 'editor' | 'viewer'
}

export interface RecentCollaborator {
  id: string
  user_id: string
  email: string
  display_name: string
  last_collaborated_at: string
}

export const projectMemberApi = {
  recentCollaborators: () =>
    http<RecentCollaborator[]>('/api/projects/recent-collaborators', { scope: 'global' }),
  list: (projectId: string) =>
    http<ProjectMember[]>(`/api/projects/${encodeURIComponent(projectId)}/members`, { scope: 'global' }),
  add: (projectId: string, body: ProjectMemberAddIn) =>
    http<ProjectMember>(`/api/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
      scope: 'global',
    }),
  remove: (projectId: string, userId: string) =>
    http<void>(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      scope: 'global',
    }),
}

// ---------------------------------------------------------------------------
// Project archive snapshots (local Git + GitHub-ready binding)
// ---------------------------------------------------------------------------

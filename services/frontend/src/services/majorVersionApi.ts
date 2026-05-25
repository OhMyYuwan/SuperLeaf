/**
 * majorVersionApi — typed client for project-level major version (git commit) routes.
 *
 * Backend: src/backend/app/api/major_versions.py
 * Working repo: ~/.yuwanlab/archives/{project_id}/
 *
 * Major versions are full-project git commits, complementary to the per-document
 * fine-grained version history. Users can also operate on the working repo
 * directly via terminal for advanced git operations (branch/reset/push).
 */

import { http } from './backendApi'

export interface CommitMeta {
  sha: string
  short_sha: string
  message: string
  author_name: string
  author_email: string
  date: string
  insertions: number
  deletions: number
  files_changed: number
}

export interface FileEntry {
  path: string
  blob_sha: string
  size: number
}

export interface FileDiff {
  path: string
  status: string  // A, M, D, R
  insertions: number
  deletions: number
  patch: string | null
}

export interface CommitDiff {
  from_sha: string
  to_sha: string
  files: FileDiff[]
  total_insertions: number
  total_deletions: number
  files_changed: number
}

export interface CommitDetail {
  sha: string
  files: FileEntry[]
}

export interface FileContent {
  path: string
  content: string
  encoding: 'utf-8' | 'base64'
}

export interface MajorVersionSnapshot {
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

export const majorVersionApi = {
  list: (projectId: string, limit = 50) =>
    http<CommitMeta[]>(
      `/api/projects/${encodeURIComponent(projectId)}/major-versions?limit=${limit}`,
    ),

  create: (projectId: string, message: string) =>
    http<MajorVersionSnapshot>(
      `/api/projects/${encodeURIComponent(projectId)}/major-versions`,
      {
        method: 'POST',
        body: JSON.stringify({ message }),
      },
    ),

  detail: (projectId: string, sha: string) =>
    http<CommitDetail>(
      `/api/projects/${encodeURIComponent(projectId)}/major-versions/${encodeURIComponent(sha)}`,
    ),

  diff: (projectId: string, sha: string, against?: string) => {
    const qs = against ? `?against=${encodeURIComponent(against)}` : ''
    return http<CommitDiff>(
      `/api/projects/${encodeURIComponent(projectId)}/major-versions/${encodeURIComponent(sha)}/diff${qs}`,
    )
  },

  readFile: (projectId: string, sha: string, path: string) =>
    http<FileContent>(
      `/api/projects/${encodeURIComponent(projectId)}/major-versions/${encodeURIComponent(sha)}/files/${encodeURI(path)}`,
    ),

  restore: (projectId: string, sha: string, message?: string) =>
    http<MajorVersionSnapshot>(
      `/api/projects/${encodeURIComponent(projectId)}/major-versions/${encodeURIComponent(sha)}/restore`,
      {
        method: 'POST',
        body: JSON.stringify({ message: message ?? null }),
      },
    ),
}

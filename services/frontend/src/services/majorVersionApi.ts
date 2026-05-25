/**
 * majorVersionApi — typed client for project-level major version (git commit) routes.
 *
 * Backend: src/backend/app/api/major_versions.py
 * Server archive repo: ~/.yuwanlab/archives/{project_id}/ on the backend host.
 *
 * Major versions are full-project git commits, complementary to the per-document
 * fine-grained version history. End users should treat this git repo as a
 * server-side archive implementation detail and use the UI to compare, restore,
 * push, or download snapshots.
 */

import { BACKEND_BASE, http } from './backendApi'

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

  downloadUrl: (projectId: string, sha: string) =>
    `${BACKEND_BASE}/api/projects/${encodeURIComponent(projectId)}/major-versions/${encodeURIComponent(sha)}/download`,

  download: async (projectId: string, sha: string): Promise<void> => {
    const response = await fetch(majorVersionApi.downloadUrl(projectId, sha), {
      method: 'GET',
      credentials: 'include',
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(detail || `下载失败：HTTP ${response.status}`)
    }
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const filename = filenameFromDisposition(disposition) ?? `superleaf-${sha.slice(0, 7)}.zip`
    const url = URL.createObjectURL(blob)
    try {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } finally {
      URL.revokeObjectURL(url)
    }
  },

  restore: (projectId: string, sha: string, message?: string) =>
    http<MajorVersionSnapshot>(
      `/api/projects/${encodeURIComponent(projectId)}/major-versions/${encodeURIComponent(sha)}/restore`,
      {
        method: 'POST',
        body: JSON.stringify({ message: message ?? null }),
      },
    ),
}

function filenameFromDisposition(disposition: string): string | null {
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8?.[1]) return decodeURIComponent(utf8[1].replace(/^"|"$/g, ''))
  const ascii = disposition.match(/filename="?([^"]+)"?/i)
  return ascii?.[1] ?? null
}

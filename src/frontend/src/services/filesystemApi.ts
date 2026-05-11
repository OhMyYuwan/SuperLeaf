/**
 * filesystemApi — frontend client for local project tree APIs.
 *
 * Endpoints (A1):
 *   GET  /api/project/tree
 *   POST /api/folders
 *   POST /api/docs
 *   GET  /api/docs/:id
 *   PUT  /api/docs/:id
 */

import { BACKEND_BASE, buildHeaders, http } from './backendApi'

const BASE = BACKEND_BASE

export interface TreeDoc {
  id: string
  name: string
  format: 'tex' | 'md' | 'txt'
  size_bytes: number
  updated_at: string
}

export interface TreeFile {
  id: string
  name: string
  mime_type: string
  size_bytes: number
  updated_at: string
}

export interface TreeFolder {
  id: string
  name: string
  folders: TreeFolder[]
  docs: TreeDoc[]
  files: TreeFile[]
}

export interface ProjectTree {
  project_id: string
  project_name: string
  root: TreeFolder
}

export interface BackendDoc {
  id: string
  project_id: string
  folder_id: string | null
  name: string
  format: 'tex' | 'md' | 'txt'
  content: string
  version: number
  updated_at: string
}

export const filesystemApi = {
  getTree: () => http<ProjectTree>('/api/project/tree'),

  renameProject: (name: string) =>
    http<{ ok: boolean }>('/api/project/name', {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),

  createFolder: (payload: { parent_folder_id?: string | null; name: string }) =>
    http<{ id: string; project_id: string; parent_folder_id: string | null; name: string }>(
      '/api/folders',
      {
        method: 'POST',
        body: JSON.stringify({
          parent_folder_id: payload.parent_folder_id ?? null,
          name: payload.name,
        }),
      },
    ),

  createDoc: (payload: {
    folder_id?: string | null
    name: string
    format: 'tex' | 'md' | 'txt'
    content?: string
  }) =>
    http<BackendDoc>('/api/docs', {
      method: 'POST',
      body: JSON.stringify({
        folder_id: payload.folder_id ?? null,
        name: payload.name,
        format: payload.format,
        content: payload.content ?? '',
      }),
    }),

  getDoc: (id: string) => http<BackendDoc>(`/api/docs/${encodeURIComponent(id)}`),

  updateDoc: (id: string, content: string) =>
    http<BackendDoc>(`/api/docs/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  renameEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string, name: string) =>
    http<{ ok: boolean }>(`/api/entities/${entityType}/${encodeURIComponent(entityId)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deleteEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string) =>
    http<{ ok: boolean; deleted_count: number }>(
      `/api/entities/${entityType}/${encodeURIComponent(entityId)}`,
      { method: 'DELETE' },
    ),

  uploadFile: async (
    file: File,
    folderId?: string | null,
  ): Promise<
    | { kind: 'doc'; id: string; name: string; format: 'tex' | 'md' | 'txt' }
    | { kind: 'file'; id: string; name: string; size_bytes: number; mime_type: string }
  > => {
    const form = new FormData()
    form.append('file', file)
    if (folderId) form.append('folder_id', folderId)
    // buildHeaders injects X-Project-Id, but for FormData we must let the
    // browser set Content-Type (multipart boundary). So copy just X-Project-Id.
    const projectHeaders = buildHeaders()
    const headers: Record<string, string> = {}
    const pid = projectHeaders.get('X-Project-Id')
    if (pid) headers['X-Project-Id'] = pid
    const resp = await fetch(`${BASE}/api/files/upload`, {
      method: 'POST',
      body: form,
      headers,
      credentials: 'include',
    })
    if (!resp.ok) throw new Error(`upload ${resp.status}`)
    return resp.json()
  },

  convertFileToDoc: (fileId: string) =>
    http<BackendDoc>(`/api/files/${encodeURIComponent(fileId)}/convert-to-doc`, {
      method: 'POST',
    }),

  moveEntity: (
    entityType: 'folder' | 'doc' | 'file',
    entityId: string,
    targetFolderId: string | null,
  ) =>
    http<{ ok: boolean }>(
      `/api/entities/${entityType}/${encodeURIComponent(entityId)}/move`,
      {
        method: 'POST',
        body: JSON.stringify({ target_folder_id: targetFolderId }),
      },
    ),

  fileUrl: (fileId: string) => `${BASE}/api/files/${encodeURIComponent(fileId)}`,

  exportZipUrl: (projectId: string) => `${BASE}/api/projects/${projectId}/export.zip`,
}

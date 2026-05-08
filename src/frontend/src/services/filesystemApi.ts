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

const BASE = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000'

export interface TreeDoc {
  id: string
  name: string
  format: 'tex' | 'md' | 'txt'
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

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText)
    throw new Error(`filesystem API ${resp.status}: ${text}`)
  }
  return (await resp.json()) as T
}

export const filesystemApi = {
  getTree: () => http<ProjectTree>('/api/project/tree'),

  renameProject: (name: string) =>
    http<{ ok: boolean }>('/api/project/name', {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),

  createFolder: (payload: { parent_folder_id?: string | null; name: string }) =>
    http('/api/folders', {
      method: 'POST',
      body: JSON.stringify({
        parent_folder_id: payload.parent_folder_id ?? null,
        name: payload.name,
      }),
    }),

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

  uploadFile: async (file: File, folderId?: string | null): Promise<{ id: string; name: string }> => {
    const form = new FormData()
    form.append('file', file)
    if (folderId) form.append('folder_id', folderId)
    const resp = await fetch(`${BASE}/api/files/upload`, { method: 'POST', body: form })
    if (!resp.ok) throw new Error(`upload ${resp.status}`)
    return (await resp.json()) as { id: string; name: string }
  },

  exportZipUrl: () => `${BASE}/api/project/export.zip`,
}

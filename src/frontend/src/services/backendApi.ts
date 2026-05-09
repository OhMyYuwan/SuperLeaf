/**
 * backendApi — typed fetch helpers for our FastAPI.
 *
 * Base URL resolution:
 *   1. import.meta.env.VITE_BACKEND_URL if provided
 *   2. http://localhost:8000 (dev default)
 */

const BASE = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000'

export interface Provider {
  id: string
  name: string
  kind: 'dify-local' | 'dify-cloud' | 'claude-direct'
  endpoint: string
  status: 'unknown' | 'ok' | 'error'
  status_detail: string
  is_active: boolean
  meta: Record<string, unknown>
  created_at: string
  updated_at: string
  has_api_key: boolean
}

export interface ProviderDraft {
  name: string
  kind: Provider['kind']
  endpoint: string
  api_key: string
  activate?: boolean
}

export interface ProviderUpdate {
  name?: string
  endpoint?: string
  api_key?: string
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (resp.status === 204) return undefined as T
  const text = await resp.text()
  if (!resp.ok) {
    throw new BackendError(resp.status, text || resp.statusText)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

export class BackendError extends Error {
  readonly status: number
  readonly detail: string
  constructor(status: number, detail: string) {
    super(`Backend ${status}: ${detail}`)
    this.status = status
    this.detail = detail
  }
}

export const providerApi = {
  list: () => http<Provider[]>('/api/providers'),
  create: (draft: ProviderDraft) =>
    http<Provider>('/api/providers', { method: 'POST', body: JSON.stringify(draft) }),
  update: (id: string, patch: ProviderUpdate) =>
    http<Provider>(`/api/providers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) =>
    http<void>(`/api/providers/${id}`, { method: 'DELETE' }),
  activate: (id: string) =>
    http<Provider>(`/api/providers/${id}/activate`, { method: 'POST' }),
  probe: (id: string) =>
    http<Provider>(`/api/providers/${id}/probe`, { method: 'POST' }),
}

export interface CachedWorkflow {
  id: string
  provider_id: string
  external_id: string
  name: string
  description: string
  kind: string
  tags: string[]
  last_synced_at: string
}

export interface RunRequest {
  document_id: string
  range_start: number
  range_end: number
  inputs?: Record<string, unknown>
  user?: string
  query?: string
  conversation_id?: string
  parent_run_id?: string
}

export interface WorkflowRun {
  id: string
  provider_id: string
  workflow_id: string
  document_id: string
  range_start: number
  range_end: number
  status: 'running' | 'completed' | 'failed' | string
  external_run_id: string
  outputs: Record<string, unknown>
  error: string
  started_at: string
  finished_at: string | null
}

export interface RunListQuery {
  document_id?: string
  workflow_id?: string
  limit?: number
}

export const workflowApi = {
  list: () => http<CachedWorkflow[]>('/api/workflows'),
  // Stream URL; callers use EventSource, not fetch.
  runStreamUrl: (id: string) => `${BASE}/api/workflows/${encodeURIComponent(id)}/run`,
  listRuns: (query?: RunListQuery) => {
    const params = new URLSearchParams()
    if (query?.document_id) params.set('document_id', query.document_id)
    if (query?.workflow_id) params.set('workflow_id', query.workflow_id)
    if (query?.limit) params.set('limit', String(query.limit))
    const qs = params.toString()
    return http<WorkflowRun[]>(`/api/workflows/runs${qs ? `?${qs}` : ''}`)
  },
  getRun: (runId: string) =>
    http<WorkflowRun>(`/api/workflows/runs/${encodeURIComponent(runId)}`),
  deleteRun: (runId: string) =>
    http<void>(`/api/workflows/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }),
}

export const BACKEND_BASE = BASE

export const healthApi = {
  check: () => http<{ status: string; service: string }>('/api/health'),
}

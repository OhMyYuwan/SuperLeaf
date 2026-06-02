import { BACKEND_BASE, BackendError, buildHeaders, http } from './backendApi'

export type DatasetSourceType = 'annotations' | 'conversations' | 'workflow_runs'
export type DatasetRecordStatus = 'all' | 'pending' | 'in_review' | 'labeled' | 'discarded'
export type DatasetResponseStatus = 'draft' | 'submitted' | 'discarded'

export interface DatasetProject {
  id: string
  project_id: string
  user_id: string
  name: string
  guidelines: string
  label_schema: Record<string, unknown>
  status: string
  created_at: string
  updated_at: string
}

export interface DatasetSourceRule {
  id: string
  dataset_project_id: string
  source_project_id: string
  user_id: string
  name: string
  source_types: DatasetSourceType[]
  filters: Record<string, unknown>
  last_cursor: Record<string, unknown>
  rule_version: number
  is_enabled: boolean
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export interface DatasetSourceRuleDraft {
  source_project_id: string
  name?: string
  source_types?: DatasetSourceType[]
  filters?: Record<string, unknown>
  is_enabled?: boolean
}

export interface DatasetBatch {
  id: string
  dataset_project_id: string
  source_rule_id: string
  user_id: string
  cursor_from: Record<string, unknown>
  cursor_to: Record<string, unknown>
  counts: Record<string, unknown>
  created_at: string
}

export interface DatasetSyncResult {
  batch: DatasetBatch
  created: number
  skipped: number
  scanned: number
}

export interface DatasetResponse {
  id: string
  dataset_project_id: string
  record_id: string
  user_id: string
  status: DatasetResponseStatus
  values: Record<string, unknown>
  lead_time_ms: number
  created_at: string
  updated_at: string
}

export interface DatasetRecord {
  id: string
  dataset_project_id: string
  batch_id: string
  source_rule_id: string
  user_id: string
  source_type: DatasetSourceType | string
  source_id: string
  source_created_at: string | null
  fingerprint: string
  fields: Record<string, unknown>
  record_metadata: Record<string, unknown>
  provenance: Record<string, unknown>
  status: Exclude<DatasetRecordStatus, 'all'> | string
  split: string
  created_at: string
  updated_at: string
  my_response?: DatasetResponse | null
}

export interface DatasetRecordList {
  records: DatasetRecord[]
  total: number
}

export interface DatasetFilterOption {
  id: string
  name: string
  kind: string
  filter_key: string
  project_id: string
  description: string
  disabled: boolean
}

export interface DatasetFilterOptions {
  agents: DatasetFilterOption[]
  skills: DatasetFilterOption[]
  workflows: DatasetFilterOption[]
}

export interface DatasetResponseDraft {
  status?: DatasetResponseStatus
  values: Record<string, unknown>
  lead_time_ms?: number
}

export const datasetApi = {
  current: () => http<DatasetProject>('/api/datasets/current'),
  updateCurrent: (body: Partial<Pick<DatasetProject, 'name' | 'guidelines' | 'label_schema'>>) =>
    http<DatasetProject>('/api/datasets/current', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  filterOptions: (sourceProjectId: string) =>
    http<DatasetFilterOptions>(`/api/datasets/current/filter-options?source_project_id=${encodeURIComponent(sourceProjectId)}`),
  listSourceRules: () => http<DatasetSourceRule[]>('/api/datasets/current/source-rules'),
  createSourceRule: (draft: DatasetSourceRuleDraft) =>
    http<DatasetSourceRule>('/api/datasets/current/source-rules', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  updateSourceRule: (id: string, patch: Partial<DatasetSourceRuleDraft>) =>
    http<DatasetSourceRule>(`/api/datasets/source-rules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  syncSourceRule: (id: string) =>
    http<DatasetSyncResult>(`/api/datasets/source-rules/${encodeURIComponent(id)}/sync`, {
      method: 'POST',
    }),
  listRecords: (params: { status?: DatasetRecordStatus; source_type?: string; limit?: number; offset?: number } = {}) => {
    const search = new URLSearchParams()
    if (params.status) search.set('status', params.status)
    if (params.source_type) search.set('source_type', params.source_type)
    if (params.limit) search.set('limit', String(params.limit))
    if (params.offset) search.set('offset', String(params.offset))
    const query = search.toString()
    return http<DatasetRecordList>(`/api/datasets/current/records${query ? `?${query}` : ''}`)
  },
  getRecord: (id: string) =>
    http<DatasetRecord>(`/api/datasets/records/${encodeURIComponent(id)}`),
  saveResponse: (recordId: string, draft: DatasetResponseDraft) =>
    http<DatasetResponse>(`/api/datasets/records/${encodeURIComponent(recordId)}/response/me`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: draft.status ?? 'draft',
        values: draft.values,
        lead_time_ms: draft.lead_time_ms ?? 0,
      }),
    }),
  submitResponse: (recordId: string, draft: DatasetResponseDraft) =>
    http<DatasetResponse>(`/api/datasets/records/${encodeURIComponent(recordId)}/response/me/submit`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'submitted',
        values: draft.values,
        lead_time_ms: draft.lead_time_ms ?? 0,
      }),
    }),
  discardRecord: (recordId: string) =>
    http<DatasetResponse>(`/api/datasets/records/${encodeURIComponent(recordId)}/discard`, {
      method: 'POST',
    }),
  async downloadExport(status: 'submitted' | 'all' | 'pending' | 'in_review' | 'labeled' | 'discarded' = 'submitted') {
    const response = await fetch(`${BACKEND_BASE}/api/datasets/current/export.zip?status=${encodeURIComponent(status)}`, {
      method: 'GET',
      credentials: 'include',
      headers: buildHeaders(),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new BackendError(response.status, text || response.statusText)
    }
    const blob = await response.blob()
    const filename = filenameFromDisposition(response.headers.get('Content-Disposition') ?? '') ?? 'dataset-export.zip'
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
}

function filenameFromDisposition(disposition: string): string | null {
  return disposition.match(/filename="([^"]+)"/i)?.[1] ?? disposition.match(/filename=([^;]+)/i)?.[1] ?? null
}

import { http } from './backendApi'

export type AnnotationAgentSuggestionStatus =
  | 'drafted'
  | 'stale'
  | 'ready'
  | 'published'
  | 'failed'

export interface AnnotationAgentSuggestion {
  id: string
  project_id: string
  doc_id: string
  annotation_id: string
  user_id: string
  agent_id: string
  source_hash: string
  status: AnnotationAgentSuggestionStatus
  suggestions: string[]
  internal_meta: Record<string, unknown>
  error: string
  created_at: string
  updated_at: string
}

export interface AnnotationAgentSuggestionRunIn {
  doc_id: string
  agent_id: string
  target_kind?: 'agent' | 'workflow'
  include_stale?: boolean
  scope?: 'current_doc'
}

export interface AnnotationAgentSuggestionRunOut {
  processed: number
  skipped: number
  failed: number
  suggestions: AnnotationAgentSuggestion[]
}

export interface AnnotationAgentSuggestionPatchIn {
  status?: AnnotationAgentSuggestionStatus
  suggestions?: string[]
}

const enc = encodeURIComponent

export const annotationAgentSuggestionApi = {
  listByDoc: (docId: string) =>
    http<AnnotationAgentSuggestion[]>(
      `/api/annotations/agent-suggestions/by-doc/${enc(docId)}`,
    ),

  run: (body: AnnotationAgentSuggestionRunIn) =>
    http<AnnotationAgentSuggestionRunOut>('/api/annotations/agent-suggestions/run', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'current_doc',
        include_stale: true,
        ...body,
      }),
    }),

  update: (id: string, patch: AnnotationAgentSuggestionPatchIn) =>
    http<AnnotationAgentSuggestion>(
      `/api/annotations/agent-suggestions/${enc(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),

  remove: (id: string) =>
    http<void>(`/api/annotations/agent-suggestions/${enc(id)}`, { method: 'DELETE' }),
}

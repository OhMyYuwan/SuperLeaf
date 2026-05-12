/**
 * operationApi — typed client for the V3 Phase 3 audit-log routes.
 *
 * Op types:
 *   - accept_suggestion / reject_suggestion (frontend-driven; POSTed from
 *     annotationStore when the user accepts/rejects a card)
 *   - restore / label_add / label_remove (recorded server-side alongside
 *     the corresponding mutation in api/versions.py)
 */

import { http } from './backendApi'

export type OperationType =
  | 'accept_suggestion'
  | 'reject_suggestion'
  | 'restore'
  | 'label_add'
  | 'label_remove'

export interface Operation {
  id: string
  doc_id: string
  type: OperationType
  payload: Record<string, unknown>
  actor: string | null
  created_at: string
}

export const operationApi = {
  list: (docId: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.offset) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return http<Operation[]>(
      `/api/docs/${encodeURIComponent(docId)}/operations${qs ? `?${qs}` : ''}`,
    )
  },

  record: (
    docId: string,
    body: { type: OperationType; payload?: Record<string, unknown> },
  ) =>
    http<Operation>(`/api/docs/${encodeURIComponent(docId)}/operations`, {
      method: 'POST',
      body: JSON.stringify({ type: body.type, payload: body.payload ?? {} }),
    }),
}

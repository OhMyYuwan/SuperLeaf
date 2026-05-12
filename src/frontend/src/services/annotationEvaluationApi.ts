/**
 * annotationEvaluationApi — thin wrapper around /api/annotations routes
 * introduced in REQ-0034. Mirrors the backend EvaluationIn / EvaluationOut
 * schemas one-for-one.
 *
 * All routes are doc-scoped; the backend enforces project ownership via
 * `get_current_project`. 404s surface as thrown Errors from `http`.
 */

import { http } from './backendApi'

export type EvaluationVerdict = 'positive' | 'negative'
export type EvaluationAdoption =
  | 'unknown'
  | 'used'
  | 'partially_used'
  | 'not_used'
  | 'later'
export type EvaluationTargetType =
  | 'agent_output'
  | 'workflow_run'
  | 'annotation'
  | 'suggestion'
export type ReviewStatus =
  | 'open'
  | 'considered'
  | 'addressed'
  | 'dismissed'

export interface EvaluationIn {
  id: string
  doc_id: string
  target_type: EvaluationTargetType
  target_id?: string
  verdict: EvaluationVerdict
  reason: string
  tags?: string[]
  adoption?: EvaluationAdoption
  training_candidate?: boolean
  context?: Record<string, unknown>
}

export interface EvaluationPatchIn {
  verdict?: EvaluationVerdict
  reason?: string
  tags?: string[]
  adoption?: EvaluationAdoption
  training_candidate?: boolean
  context?: Record<string, unknown>
}

export interface EvaluationOut {
  id: string
  annotation_id: string
  doc_id: string
  target_type: EvaluationTargetType
  target_id: string
  verdict: EvaluationVerdict
  reason: string
  tags: string[]
  adoption: EvaluationAdoption
  training_candidate: boolean
  context: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ReviewStateOut {
  annotation_id: string
  doc_id: string
  status: ReviewStatus
  updated_at: string
}

// --- Annotation cards (V3 phase 2.5: server-side source of truth) ----------

export interface AnnotationThreadMessageDto {
  id: string
  role: 'user' | 'agent'
  content: string
  created_at: string
  agent_id?: string | null
  agent_name?: string | null
}

// Opaque dictionary of frontend AttachedFile fields. Backend round-trips
// these as-is via JSON so we don't have to grow a column when the resolver
// attaches new metadata.
export type AnnotationAttachedFileDto = Record<string, unknown>

export interface AnnotationDto {
  id: string
  doc_id: string
  project_id: string
  kind: 'annotation' | 'suggestion' | 'risk' | 'user-comment'
  status: string
  range_from: number
  range_to: number
  target_text: string
  content: string
  severity: 'low' | 'medium' | 'high'
  workflow_id: string
  agent_name: string
  conversation_id: string
  original: string
  proposed: string
  reason: string
  risk_type: string
  mitigation: string
  thread: AnnotationThreadMessageDto[]
  attached_files: AnnotationAttachedFileDto[]
  created_at: string
  updated_at: string
}

export interface AnnotationCreateIn {
  id: string
  doc_id: string
  kind: AnnotationDto['kind']
  status: string
  range_from: number
  range_to: number
  target_text: string
  content: string
  severity: AnnotationDto['severity']
  workflow_id: string
  agent_name: string
  conversation_id: string
  original: string
  proposed: string
  reason: string
  risk_type: string
  mitigation: string
  thread: AnnotationThreadMessageDto[]
  attached_files: AnnotationAttachedFileDto[]
  created_at: string
}

export interface AnnotationPatchIn {
  status?: string
  range_from?: number
  range_to?: number
  content?: string
  thread?: AnnotationThreadMessageDto[]
}

const enc = encodeURIComponent

export const annotationEvaluationApi = {
  listByDoc: (docId: string) =>
    http<EvaluationOut[]>(`/api/annotations/by-doc/${enc(docId)}/evaluations`),

  create: (annotationId: string, body: EvaluationIn) =>
    http<EvaluationOut>(`/api/annotations/${enc(annotationId)}/evaluations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  update: (annotationId: string, evaluationId: string, patch: EvaluationPatchIn) =>
    http<EvaluationOut>(
      `/api/annotations/${enc(annotationId)}/evaluations/${enc(evaluationId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    ),

  remove: (annotationId: string, evaluationId: string) =>
    http<void>(
      `/api/annotations/${enc(annotationId)}/evaluations/${enc(evaluationId)}`,
      { method: 'DELETE' },
    ),

  setReviewStatus: (annotationId: string, docId: string, status: ReviewStatus) =>
    http<ReviewStateOut>(
      `/api/annotations/${enc(annotationId)}/review-status`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_id: docId, status }),
      },
    ),

  listReviewStatesByDoc: (docId: string) =>
    http<ReviewStateOut[]>(`/api/annotations/by-doc/${enc(docId)}/review-states`),

  listTagsByDoc: (docId: string) =>
    http<string[]>(`/api/annotations/by-doc/${enc(docId)}/evaluation-tags`),

  // --- Annotation cards ---
  listAnnotationsByDoc: (docId: string) =>
    http<AnnotationDto[]>(`/api/annotations/by-doc/${enc(docId)}/items`),

  createAnnotation: (body: AnnotationCreateIn) =>
    http<AnnotationDto>('/api/annotations/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  patchAnnotation: (annotationId: string, body: AnnotationPatchIn) =>
    http<AnnotationDto>(`/api/annotations/items/${enc(annotationId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  removeAnnotation: (annotationId: string) =>
    http<void>(`/api/annotations/items/${enc(annotationId)}`, { method: 'DELETE' }),
}

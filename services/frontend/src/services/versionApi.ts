/**
 * versionApi — typed client for the V3 Phase 3 history & diff routes.
 *
 * Backend lives in src/backend/app/api/versions.py. Diff payload follows the
 * Overleaf history-v1 shape: a list of `{u}|{i,meta}|{d,meta}` parts, or
 * `{binary: true}` when at least one side isn't decodable text.
 */

import { http } from './backendApi'
import type { BackendDoc } from './filesystemApi'

export interface VersionLabel {
  id: string
  version: number
  text: string
  created_at: string
}

export interface VersionMeta {
  id: string
  version: number
  blob_hash: string
  created_at: string
  origin: 'auto_save' | 'accept_suggestion' | 'manual' | 'restore' | 'ai_edit'
  actor: string | null
  byte_length: number
  string_length: number | null
  labels: VersionLabel[]
  // Only the single-version GET populates `content`; the list endpoint omits
  // it to keep the payload light.
  content: string | null
  binary: boolean
}

export type DiffPart =
  | { u: string }
  | { i: string; meta?: { start_ts?: number } }
  | { d: string; meta?: { start_ts?: number } }

export type DiffPayload = DiffPart[] | { binary: true }

export interface DiffResponse {
  diff: DiffPayload
}

export const versionApi = {
  list: (docId: string) =>
    http<VersionMeta[]>(`/api/docs/${encodeURIComponent(docId)}/versions`),

  get: (docId: string, version: number) =>
    http<VersionMeta>(
      `/api/docs/${encodeURIComponent(docId)}/versions/${version}`,
    ),

  diff: (docId: string, from: number, to: number | 'current') =>
    http<DiffResponse>(
      `/api/docs/${encodeURIComponent(docId)}/diff?from=${from}&to=${to}`,
    ),

  restore: (docId: string, version: number) =>
    http<BackendDoc>(
      `/api/docs/${encodeURIComponent(docId)}/restore/${version}`,
      { method: 'POST' },
    ),

  addLabel: (docId: string, version: number, text: string) =>
    http<VersionLabel>(`/api/docs/${encodeURIComponent(docId)}/labels`, {
      method: 'POST',
      body: JSON.stringify({ version, text }),
    }),

  removeLabel: (docId: string, labelId: string) =>
    http<void>(
      `/api/docs/${encodeURIComponent(docId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' },
    ),
}

export function isDiffBinary(d: DiffPayload): d is { binary: true } {
  return !Array.isArray(d) && (d as { binary?: boolean }).binary === true
}

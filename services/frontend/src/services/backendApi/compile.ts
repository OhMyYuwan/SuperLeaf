/**
 * LaTeX 编译与 SyncTeX 相关 API。
 */

import { http, buildHeaders, BackendError, BASE } from './client'

export interface CompilerInfo {
  available: string[]
  default: string
}

export interface CompileRequest {
  compiler?: string
  main_doc_id?: string
}

export interface CompileResult {
  ok: boolean
  compiler: string
  duration_ms: number
  error: string
  log_tail: string
  pdf_bytes: number
}

export interface CompileSyncToPdfRequest {
  document_id: string
  offset: number
}

export interface CompileSyncToPdfResult {
  page: number
  x: number
  y: number
  width: number | null
  height: number | null
  line: number
  column: number
}

export interface CompileSyncFromPdfRequest {
  page: number
  x: number
  y: number
}

export interface CompileSyncFromPdfResult {
  document_id: string
  offset: number
  line: number
  column: number
  source_path: string
}

export interface CompileSettings {
  main_doc_id: string
  compiler: string
}

export const compileApi = {
  listCompilers: () => http<CompilerInfo>('/api/compile/compilers'),
  rescanCompilers: () =>
    http<CompilerInfo>('/api/compile/rescan', { method: 'POST' }),
  compile: (body?: CompileRequest) =>
    http<CompileResult>('/api/compile', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),
  syncToPdf: (body: CompileSyncToPdfRequest) =>
    http<CompileSyncToPdfResult>('/api/compile/sync-to-pdf', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  syncFromPdf: (body: CompileSyncFromPdfRequest) =>
    http<CompileSyncFromPdfResult>('/api/compile/sync-from-pdf', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  pdfUrl: (projectId: string) => `${BASE}/api/projects/${projectId}/compile.pdf`,
  getLog: async () => {
    const resp = await fetch(`${BASE}/api/compile/log`, {
      credentials: 'include',
      headers: buildHeaders(),
    })
    if (!resp.ok) throw new BackendError(resp.status, resp.statusText)
    return resp.text()
  },
  getSettings: () => http<CompileSettings>('/api/compile/settings'),
  updateSettings: (body: Partial<CompileSettings>) =>
    http<CompileSettings>('/api/compile/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
}

// Conversations / chat

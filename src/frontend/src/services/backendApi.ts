/**
 * backendApi — typed fetch helpers for our FastAPI.
 *
 * Base URL resolution:
 *   1. import.meta.env.VITE_BACKEND_URL if provided
 *   2. Auto-detect based on current hostname (for LAN access)
 *   3. http://localhost:8000 (fallback)
 */

function getBackendUrl(): string {
  if (import.meta.env.VITE_BACKEND_URL) {
    return import.meta.env.VITE_BACKEND_URL
  }
  // Auto-detect: use current hostname with backend port
  // This allows LAN devices to access backend via server IP
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location
    // Only auto-detect for non-localhost access
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      const url = `${protocol}//${hostname}:8000`
      console.log('[backendApi] Auto-detected backend URL:', url, '(from hostname:', hostname, ')')
      return url
    }
    // For localhost, use 127.0.0.1 to force IPv4 (backend only listens on IPv4)
    if (hostname === 'localhost') {
      console.log('[backendApi] Using IPv4 backend URL: http://127.0.0.1:8000 (forced IPv4 for localhost)')
      return 'http://127.0.0.1:8000'
    }
  }
  console.log('[backendApi] Using default backend URL: http://127.0.0.1:8000')
  return 'http://127.0.0.1:8000'
}

const BASE = getBackendUrl()
console.log('[backendApi] Backend URL initialized:', BASE)

export interface Provider {
  id: string
  name: string
  kind: 'dify-local' | 'dify-cloud' | 'claude-direct' | 'nanobot'
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
  is_disabled: boolean
}

export interface ContextFileRef {
  name?: string
  document_id?: string
  content?: string
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
  // Files referenced via @-mention. Content is injected verbatim into the
  // workflow's input node output (and, downstream, into agent prompts).
  context_files?: ContextFileRef[]
}

export interface WorkflowRun {
  id: string
  provider_id: string
  workflow_id: string
  workflow_definition_id: string | null
  document_id: string
  range_start: number
  range_end: number
  status: 'running' | 'completed' | 'failed' | string
  external_run_id: string
  outputs: Record<string, unknown>
  trace: NodeTrace[]
  current_round: number
  max_rounds: number
  error: string
  started_at: string
  finished_at: string | null
}

export interface NodeTrace {
  nodeId: string
  agentId?: string
  workflowDefId?: string
  startTime: string
  endTime?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  input?: unknown
  output?: unknown
  error?: string
}

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
  execution_mode: 'parallel' | 'pipeline' | 'roundtable' | 'graph'
  graph: WorkflowGraph
  config: WorkflowConfig
  version: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface WorkflowNode {
  id: string
  // Canvas-generated graphs use 'agent' (atom), 'loop' (container), and
  // 'input' / 'output' (workflow boundary nodes). Legacy modes
  // (parallel/pipeline/roundtable) may still carry other values.
  type: 'agent' | 'loop' | 'input' | 'output' | 'workflow' | 'merge' | 'judge'
  label?: string
  config?: Record<string, unknown>
}

export interface WorkflowEdge {
  source: string
  target: string
  condition?: string
}

export interface WorkflowConfig {
  max_rounds?: number
  stop_conditions?: string[]
  merge_strategy?: 'concat' | 'vote' | 'first'
  [key: string]: unknown
}

export interface WorkflowDefinitionDraft {
  name: string
  description?: string
  execution_mode: WorkflowDefinition['execution_mode']
  graph: WorkflowGraph
  config?: WorkflowConfig
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
  disable: (id: string) =>
    http<CachedWorkflow>(`/api/workflows/${encodeURIComponent(id)}/disable`, { method: 'POST' }),
  enable: (id: string) =>
    http<CachedWorkflow>(`/api/workflows/${encodeURIComponent(id)}/enable`, { method: 'POST' }),
}

export const workflowDefinitionApi = {
  list: () => http<WorkflowDefinition[]>('/api/workflows/definitions'),
  get: (id: string) =>
    http<WorkflowDefinition>(`/api/workflows/definitions/${encodeURIComponent(id)}`),
  create: (draft: WorkflowDefinitionDraft) =>
    http<WorkflowDefinition>('/api/workflows/definitions', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  update: (id: string, draft: WorkflowDefinitionDraft) =>
    http<WorkflowDefinition>(`/api/workflows/definitions/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(draft),
    }),
  delete: (id: string) =>
    http<void>(`/api/workflows/definitions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  executeStreamUrl: (id: string) =>
    `${BASE}/api/workflows/definitions/${encodeURIComponent(id)}/execute`,
}

export const BACKEND_BASE = BASE

export const healthApi = {
  check: () => http<{ status: string; service: string }>('/api/health'),
}

// LaTeX compilation
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
  pdfUrl: () => `${BASE}/api/compile/pdf`,
  getLog: async () => {
    const resp = await fetch(`${BASE}/api/compile/log`)
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
export interface Conversation {
  id: string
  document_id: string
  workflow_id: string
  title: string
  external_conversation_id: string
  created_at: string
  updated_at: string
  message_count: number
  last_message_preview: string
}

export interface ConversationCreate {
  document_id: string
  workflow_id: string
  title?: string
}

export interface ConversationUpdate {
  title?: string
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'agent'
  content: string
  range_start: number | null
  range_end: number | null
  external_message_id: string
  error: string
  created_at: string
}

export interface MessageSend {
  content: string
  range_start?: number
  range_end?: number
  inputs?: Record<string, unknown>
}

export interface ConversationListQuery {
  document_id?: string
  workflow_id?: string
}

export const conversationApi = {
  list: (query?: ConversationListQuery) => {
    const params = new URLSearchParams()
    if (query?.document_id) params.set('document_id', query.document_id)
    if (query?.workflow_id) params.set('workflow_id', query.workflow_id)
    const qs = params.toString()
    return http<Conversation[]>(`/api/conversations${qs ? `?${qs}` : ''}`)
  },
  create: (body: ConversationCreate) =>
    http<Conversation>('/api/conversations', { method: 'POST', body: JSON.stringify(body) }),
  get: (id: string) => http<Conversation>(`/api/conversations/${encodeURIComponent(id)}`),
  update: (id: string, body: ConversationUpdate) =>
    http<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  delete: (id: string) =>
    http<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listMessages: (conversationId: string) =>
    http<Message[]>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`),
  // sendMessage returns SSE stream URL; caller uses EventSource or fetch.
  sendMessageUrl: (conversationId: string) =>
    `${BASE}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
}

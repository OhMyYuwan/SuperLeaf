/**
 * backendApi — typed fetch helpers for our FastAPI.
 *
 * Base URL resolution:
 *   1. window.__SUPERLEAF_CONFIG__.backendUrl if provided by deployment
 *   2. import.meta.env.VITE_BACKEND_URL if provided at build time
 *   3. Auto-detect based on current hostname for local/LAN development
 *   4. http://localhost:8000 fallback
 */

import { getRuntimeConfigValue, normalizeHttpBase } from './runtimeConfig'

function getBackendUrl(): string {
  const runtimeBackendUrl = getRuntimeConfigValue('backendUrl')
  if (runtimeBackendUrl !== undefined) {
    return normalizeHttpBase(runtimeBackendUrl)
  }
  if (import.meta.env.VITE_BACKEND_URL) {
    return normalizeHttpBase(import.meta.env.VITE_BACKEND_URL)
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

export function getLocalServiceUrl(port: number): string {
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location
    const host = hostname === 'localhost' ? '127.0.0.1' : hostname
    return `${protocol}//${host}:${port}`
  }
  return `http://127.0.0.1:${port}`
}

export interface Provider {
  id: string
  name: string
  kind: 'dify-local' | 'dify-cloud' | 'claude-direct' | 'nanobot' | 'native'
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

export interface ProviderModel {
  id: string
  name: string
  description: string
}

export async function http<T>(path: string, init?: HttpInit): Promise<T> {
  const headers = buildHeaders(init?.headers, init?.scope ?? 'project')
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  })
  if (resp.status === 401) {
    notifyUnauthorized()
  }
  if (resp.status === 204) return undefined as T
  const text = await resp.text()
  if (!resp.ok) {
    throw new BackendError(resp.status, parseErrorDetail(text) || resp.statusText)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

function parseErrorDetail(text: string): string {
  if (!text) return ''
  try {
    const payload = JSON.parse(text) as { detail?: unknown }
    if (typeof payload.detail === 'string') return payload.detail
    if (Array.isArray(payload.detail)) {
      return payload.detail
        .map((item) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object' && 'msg' in item) return String((item as { msg: unknown }).msg)
          return ''
        })
        .filter(Boolean)
        .join('; ')
    }
  } catch {
    return text
  }
  return text
}

export type RequestScope = 'project' | 'global'

export interface HttpInit extends Omit<RequestInit, 'headers'> {
  headers?: HeadersInit
  // 'project' (default) injects the X-Project-Id header from projectStore.
  // 'global' skips that injection — used by /api/projects, /api/health, etc.
  scope?: RequestScope
}

/** Compose request headers with optional X-Project-Id injection.
 *
 *  Exposed so SSE callers (which use fetch directly) can reuse the same logic.
 *  Reads `currentProjectId` from `projectStore` lazily to avoid an import cycle.
 */
export function buildHeaders(extra?: HeadersInit, scope: RequestScope = 'project'): Headers {
  const headers = new Headers(extra ?? undefined)
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (scope === 'project' && !headers.has('X-Project-Id')) {
    const pid = readCurrentProjectId()
    if (pid) headers.set('X-Project-Id', pid)
  }
  // Stable per-browser id so the SSE event stream can flag self-originated
  // events and avoid double-applying optimistic mutations.
  if (!headers.has('X-Client-Id')) {
    headers.set('X-Client-Id', getClientId())
  }
  return headers
}

const CLIENT_ID_KEY = 'yuwan-client-id'
let cachedClientId: string | null = null

export function getClientId(): string {
  if (cachedClientId) return cachedClientId
  if (typeof localStorage === 'undefined') {
    cachedClientId = `tmp-${Math.random().toString(36).slice(2, 10)}`
    return cachedClientId
  }
  const existing = localStorage.getItem(CLIENT_ID_KEY)
  if (existing) {
    cachedClientId = existing
    return existing
  }
  const fresh = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `c-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`
  localStorage.setItem(CLIENT_ID_KEY, fresh)
  cachedClientId = fresh
  return fresh
}

// Avoids `import { useProjectStore }` at module load (circular: projectStore
// uses backendApi for its own HTTP calls). Resolved lazily on first call.
let projectIdReader: (() => string | null) | null = null

export function registerProjectIdReader(reader: () => string | null): void {
  projectIdReader = reader
}

function readCurrentProjectId(): string | null {
  return projectIdReader ? projectIdReader() : null
}

// 401 interceptor — userStore registers a handler that clears its state and
// triggers a router-level redirect to /login. Lazy registration same as above.
const unauthorizedHandlers: Array<() => void> = []

export function registerUnauthorizedHandler(cb: () => void): void {
  unauthorizedHandlers.push(cb)
}

function notifyUnauthorized(): void {
  for (const cb of unauthorizedHandlers) {
    try {
      cb()
    } catch (e) {
      console.warn('[backendApi] unauthorized handler threw', e)
    }
  }
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
  listModels: (id: string) =>
    http<ProviderModel[]>(`/api/providers/${id}/models`),
}

export interface NativeAgentCredential {
  id: string
  user_id: string
  name: string
  base_url: string
  runtime_kind: string
  default_model: string
  status: 'unknown' | 'ok' | 'error' | string
  status_detail: string
  meta: Record<string, unknown>
  created_at: string
  updated_at: string
  has_api_key: boolean
}

export interface NativeAgentCredentialDraft {
  name: string
  base_url: string
  api_key: string
  runtime_kind?: string
  default_model: string
}

export interface NativeAgentCredentialPatch {
  name?: string
  base_url?: string
  api_key?: string
  runtime_kind?: string
  default_model?: string
}

export interface Skill {
  id: string
  owner_user_id: string
  name: string
  public_name: string
  description: string
  content: string
  visibility: 'system' | 'private' | 'public' | string
  source: 'bundled' | 'upload' | string
  version: number
  tags: string[]
  can_edit: boolean
  created_at: string
  updated_at: string
  published_at: string | null
}

export interface SkillMarketplaceEntry {
  id: string
  name: string
  display_name: string
  version: string
  author_github: string
  description: string
  tags: string[]
  license: string
  path: string
  entry: string
  skill_url: string
  entry_url: string
  readme_url: string
  checksum_sha256: string
  repo_url: string
  source_url: string
  source_ref: string
  skill_name: string
  install_command: string
  installed: boolean
  installed_skill_id: string | null
  installed_version: string
  update_available: boolean
}

export interface SkillMarketplace {
  catalog_url: string
  skills: SkillMarketplaceEntry[]
}

export interface SkillMarketplaceInstallResult {
  skill: Skill
  marketplace_entry: SkillMarketplaceEntry
}

export interface SkillMarketplaceCloneResult {
  skill: Skill
}

export interface SkillDraft {
  name: string
  folder_name?: string
  entry_filename?: string
  description?: string
  content: string
  tags?: string[]
}

export interface SkillRecipeDraft {
  name?: string
  description?: string
  repo_url?: string
  source_url?: string
  source_ref?: string
  skill_name?: string
  install_command?: string
  tags?: string[]
}

export interface SkillPatch {
  name?: string
  description?: string
  content?: string
  tags?: string[]
}

export interface NativeAgent {
  id: string
  project_id: string
  owner_user_id: string
  provider_id: string
  name: string
  description: string
  model: string
  instructions: string
  agent_md: string
  skill_ids: string[]
  workspace_path: string
  setup_status: string
  setup_log: string
  output_contract: 'annotation' | 'plan' | 'workflow' | 'freeform' | string
  runtime_config: Record<string, unknown>
  is_enabled: boolean
  created_at: string
  updated_at: string
}

export interface NativeAgentSkillRecipe {
  source?: string
  marketplace_id?: string
  repo_url: string
  source_url?: string
  source_ref?: string
  skill_name: string
  install_command?: string
}

export interface NativeAgentSkillInstall {
  id: string
  project_id: string
  user_id: string
  agent_id: string
  skill_id: string
  source: string
  marketplace_id: string
  repo_url: string
  source_ref: string
  skill_name: string
  folder_name: string
  install_command: string
  folder_path: string
  manifest: Record<string, unknown>
  status: string
  install_log: string
  created_at: string
  updated_at: string
  installed_at: string | null
}

export interface NativeAgentMcpServer {
  id: string
  name: string
  enabled: boolean
  transport?: string
  endpoint?: string
  command: string
  args: string[]
  env?: Record<string, string>
  allowed_tools?: string[]
}

export interface NativeMcpServerConfig {
  id: string
  user_id: string
  preset_id: string
  source: 'catalog' | 'custom' | string
  name: string
  description: string
  transport: string
  endpoint: string
  command: string
  args: string[]
  env_keys: string[]
  allowed_tools: string[]
  is_enabled: boolean
  status: 'unknown' | 'ok' | 'error' | string
  status_detail: string
  last_probe_at: string | null
  last_probe_status: string
  last_probe_detail: string
  last_golden_at: string | null
  last_golden_status: string
  last_golden_detail: string
  last_tool_count: number
  created_at: string
  updated_at: string
}

export interface NativeMcpServerConfigDraft {
  preset_id?: string
  source?: 'catalog' | 'custom'
  name?: string
  description?: string
  transport?: string
  endpoint?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  allowed_tools?: string[]
  is_enabled?: boolean
}

export interface NativeMcpServerConfigPatch {
  name?: string
  description?: string
  transport?: string
  endpoint?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  allowed_tools?: string[]
  is_enabled?: boolean
}

export interface McpPreset {
  id: string
  name: string
  owner?: string
  qualified_name?: string
  registry?: 'official' | 'external' | string
  official_recommended?: boolean
  description: string
  category: string
  capabilities: string[]
  source: Record<string, unknown>
  transport: {
    type: string
    endpoint?: string
    url?: string
    command: string
    args: string[]
  }
  env_schema: Array<{
    name: string
    label?: string
    required?: boolean
    required_for_reliable_use?: boolean
    secret?: boolean
    description?: string
  }>
  tool_policy: {
    default_allowed_tools?: string[]
    recommended_tools?: string[]
    dangerous_tools?: string[]
  }
  risk: {
    level: string
    flags?: string[]
    reasons?: string[]
  }
  verification: {
    status: string
    grade?: string
    golden_tests?: string[]
    known_limitations?: string[]
    not_for?: string[]
  }
}

export interface McpCatalog {
  catalog_root: string
  id: string
  name: string
  version: string
  updated_at: string
  registries?: Array<{ id: string; name: string; description?: string }>
  presets: McpPreset[]
}

export interface McpExecutionPolicy {
  remote_enabled: boolean
  stdio_enabled: boolean
  inline_config_enabled: boolean
  remote_private_networks_enabled: boolean
  allowed_transports: string[]
}

export interface McpProbeResult {
  status: string
  server_id: string
  server_name: string
  tools: Array<{ name: string; function_name: string; description: string; parameters: Record<string, unknown> }>
  missing_tools: string[]
  warnings: string[]
  requires_env: string[]
}

export interface McpGoldenTestResult {
  status: string
  passed: boolean
  preset_id: string
  test_id: string
  matched?: Record<string, unknown>
  warnings?: string[]
  error?: string
  raw_preview?: string
}

export type OfficialBadgeStyle = 'metal' | 'minimal'

export interface OfficialBadgeUiSettings {
  style: OfficialBadgeStyle
  allowed_styles: OfficialBadgeStyle[]
  toggle_enabled: boolean
  source: 'env' | 'runtime_override' | string
}

export interface AgentWorkspaceFile {
  path: string
  type: 'file' | 'directory' | string
  size: number
}

export interface NativeAgentDraft {
  name: string
  description?: string
  provider_id: string
  model: string
  instructions: string
  agent_md?: string
  skill_ids?: string[]
  skill_recipes?: NativeAgentSkillRecipe[]
  output_contract?: NativeAgent['output_contract']
  runtime_config?: Record<string, unknown>
  is_enabled?: boolean
}

export interface NativeAgentPatch {
  name?: string
  description?: string
  provider_id?: string
  model?: string
  instructions?: string
  agent_md?: string
  skill_ids?: string[]
  skill_recipes?: NativeAgentSkillRecipe[]
  output_contract?: NativeAgent['output_contract']
  runtime_config?: Record<string, unknown>
  is_enabled?: boolean
}

export const nativeAgentApi = {
  ui: {
    officialBadge: () => http<OfficialBadgeUiSettings>('/api/native-agent/ui/official-badge'),
  },
  credentials: {
    list: () => http<NativeAgentCredential[]>('/api/native-agent/credentials'),
    create: (draft: NativeAgentCredentialDraft) =>
      http<NativeAgentCredential>('/api/native-agent/credentials', {
        method: 'POST',
        body: JSON.stringify(draft),
      }),
    update: (id: string, patch: NativeAgentCredentialPatch) =>
      http<NativeAgentCredential>(`/api/native-agent/credentials/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    remove: (id: string) =>
      http<void>(`/api/native-agent/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    probe: (id: string) =>
      http<NativeAgentCredential>(`/api/native-agent/credentials/${encodeURIComponent(id)}/probe`, {
        method: 'POST',
      }),
  },
  skills: {
    list: () => http<Skill[]>('/api/native-agent/skills'),
    create: (draft: SkillDraft) =>
      http<Skill>('/api/native-agent/skills', { method: 'POST', body: JSON.stringify(draft) }),
    createRecipe: (draft: SkillRecipeDraft) =>
      http<Skill>('/api/native-agent/skills/recipe', { method: 'POST', body: JSON.stringify(draft) }),
    update: (id: string, patch: SkillPatch) =>
      http<Skill>(`/api/native-agent/skills/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    publish: (id: string) =>
      http<Skill>(`/api/native-agent/skills/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
      }),
    unpublish: (id: string) =>
      http<Skill>(`/api/native-agent/skills/${encodeURIComponent(id)}/unpublish`, {
        method: 'POST',
      }),
    remove: (id: string) =>
      http<void>(`/api/native-agent/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  marketplace: {
    list: () => http<SkillMarketplace>('/api/native-agent/skill-marketplace'),
    install: (id: string) =>
      http<SkillMarketplaceInstallResult>(`/api/native-agent/skill-marketplace/${encodeURIComponent(id)}/install`, {
        method: 'POST',
      }),
    update: (id: string) =>
      http<SkillMarketplaceInstallResult>(`/api/native-agent/skill-marketplace/${encodeURIComponent(id)}/update`, {
        method: 'POST',
      }),
    uninstall: (id: string) =>
      http<void>(`/api/native-agent/skill-marketplace/${encodeURIComponent(id)}/uninstall`, {
        method: 'DELETE',
      }),
    cloneToLocal: (id: string, name: string) =>
      http<SkillMarketplaceCloneResult>(`/api/native-agent/skill-marketplace/${encodeURIComponent(id)}/clone-to-local`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
  },
  mcp: {
    policy: () => http<McpExecutionPolicy>('/api/native-agent/mcp/policy'),
    catalog: () => http<McpCatalog>('/api/native-agent/mcp/catalog'),
    servers: () => http<NativeMcpServerConfig[]>('/api/native-agent/mcp/servers'),
    createServer: (body: NativeMcpServerConfigDraft) =>
      http<NativeMcpServerConfig>('/api/native-agent/mcp/servers', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ensurePresetServer: (presetId: string, body?: NativeMcpServerConfigDraft) =>
      http<NativeMcpServerConfig>(`/api/native-agent/mcp/servers/from-preset/${encodeURIComponent(presetId)}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),
    updateServer: (id: string, patch: NativeMcpServerConfigPatch) =>
      http<NativeMcpServerConfig>(`/api/native-agent/mcp/servers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    deleteServer: (id: string) =>
      http<void>(`/api/native-agent/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    probeServer: (id: string) =>
      http<McpProbeResult>(`/api/native-agent/mcp/servers/${encodeURIComponent(id)}/probe`, {
        method: 'POST',
      }),
    goldenTestServer: (id: string, body?: { test_id?: string }) =>
      http<McpGoldenTestResult>(`/api/native-agent/mcp/servers/${encodeURIComponent(id)}/golden-test`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),
    probe: (body: { preset_id?: string; server?: NativeAgentMcpServer; env?: Record<string, string>; allowed_tools?: string[] }) =>
      http<McpProbeResult>('/api/native-agent/mcp/probe', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    goldenTest: (body: { preset_id: string; test_id?: string; server?: NativeAgentMcpServer; env?: Record<string, string> }) =>
      http<McpGoldenTestResult>('/api/native-agent/mcp/golden-test', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  agents: {
    list: (providerId?: string) => {
      const qs = providerId ? `?provider_id=${encodeURIComponent(providerId)}` : ''
      return http<NativeAgent[]>(`/api/native-agent/agents${qs}`)
    },
    create: (draft: NativeAgentDraft) =>
      http<NativeAgent>('/api/native-agent/agents', {
        method: 'POST',
        body: JSON.stringify(draft),
      }),
    update: (id: string, patch: NativeAgentPatch) =>
      http<NativeAgent>(`/api/native-agent/agents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    installs: (id: string) =>
      http<NativeAgentSkillInstall[]>(`/api/native-agent/agents/${encodeURIComponent(id)}/skills`),
    installSkill: (id: string, recipe: NativeAgentSkillRecipe) =>
      http<NativeAgentSkillInstall>(`/api/native-agent/agents/${encodeURIComponent(id)}/skills/install-npx`, {
        method: 'POST',
        body: JSON.stringify(recipe),
      }),
    workspaceTree: (id: string) =>
      http<AgentWorkspaceFile[]>(`/api/native-agent/agents/${encodeURIComponent(id)}/workspace/tree`),
    remove: (id: string) =>
      http<void>(`/api/native-agent/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
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
  // React Flow handle IDs. Required for Loop containers, which expose two
  // handles per side (source + target overlapped); without these, re-loaded
  // graphs can't tell which handle an edge was attached to and all edges
  // collapse onto whichever handle React Flow picks as the default.
  source_handle?: string | null
  target_handle?: string | null
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

// Workflow Test Cases — reusable fixtures for running the test panel against
// a saved scenario. Orthogonal to run-history (which is every real invocation).
export interface WorkflowTestCase {
  id: string
  definition_id: string
  name: string
  prompt: string
  inputs: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface WorkflowTestCaseDraft {
  name: string
  prompt?: string
  inputs?: Record<string, unknown>
}

export const workflowTestCaseApi = {
  list: (definitionId: string) =>
    http<WorkflowTestCase[]>(
      `/api/workflows/definitions/${encodeURIComponent(definitionId)}/test-cases`,
    ),
  create: (definitionId: string, draft: WorkflowTestCaseDraft) =>
    http<WorkflowTestCase>(
      `/api/workflows/definitions/${encodeURIComponent(definitionId)}/test-cases`,
      { method: 'POST', body: JSON.stringify(draft) },
    ),
  update: (definitionId: string, caseId: string, draft: WorkflowTestCaseDraft) =>
    http<WorkflowTestCase>(
      `/api/workflows/definitions/${encodeURIComponent(definitionId)}/test-cases/${encodeURIComponent(caseId)}`,
      { method: 'PUT', body: JSON.stringify(draft) },
    ),
  delete: (definitionId: string, caseId: string) =>
    http<void>(
      `/api/workflows/definitions/${encodeURIComponent(definitionId)}/test-cases/${encodeURIComponent(caseId)}`,
      { method: 'DELETE' },
    ),
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
  role: 'user' | 'agent' | 'system'
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

export interface MessageInject {
  role: 'agent' | 'user' | 'system'
  content: string
  range_start?: number
  range_end?: number
  error?: string
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
  injectMessage: (conversationId: string, body: MessageInject) =>
    http<Message>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/inject`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
}

// ---------------------------------------------------------------------------
// Project members (multi-user collaboration)
// ---------------------------------------------------------------------------

export interface ProjectMember {
  id: string
  project_id: string
  user_id: string
  user_email: string
  user_display_name: string
  role: 'editor' | 'viewer'
  status: string
  created_at: string
}

export interface ProjectMemberAddIn {
  email: string
  role?: 'editor' | 'viewer'
}

export interface RecentCollaborator {
  id: string
  user_id: string
  email: string
  display_name: string
  last_collaborated_at: string
}

export const projectMemberApi = {
  recentCollaborators: () =>
    http<RecentCollaborator[]>('/api/projects/recent-collaborators', { scope: 'global' }),
  list: (projectId: string) =>
    http<ProjectMember[]>(`/api/projects/${encodeURIComponent(projectId)}/members`, { scope: 'global' }),
  add: (projectId: string, body: ProjectMemberAddIn) =>
    http<ProjectMember>(`/api/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'POST',
      body: JSON.stringify(body),
      scope: 'global',
    }),
  remove: (projectId: string, userId: string) =>
    http<void>(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      scope: 'global',
    }),
}

// ---------------------------------------------------------------------------
// Project archive snapshots (local Git + GitHub-ready binding)
// ---------------------------------------------------------------------------

export interface ProjectArchiveBinding {
  project_id: string
  local_repo_path: string
  github_account_id: string
  github_repo_url: string
  github_owner: string
  github_repo: string
  github_branch: string
  github_path: string
  github_private_required: boolean
  github_bound_at: string | null
  last_local_commit_sha: string
  last_pushed_commit_sha: string
}

export interface ProjectArchiveSnapshot {
  id: string
  project_id: string
  commit_sha: string
  message: string
  doc_count: number
  file_count: number
  byte_count: number
  pushed_to_github: boolean
  created_at: string
}

export interface ProjectArchiveStatus {
  binding: ProjectArchiveBinding
  snapshots: ProjectArchiveSnapshot[]
  local_dirty: boolean
  remote_configured: boolean
}

export interface ProjectArchiveBindingDraft {
  github_repo_url?: string
  github_owner: string
  github_repo: string
  github_branch: string
  github_path?: string
  github_private_required: boolean
}

export interface GitHubAccountStatus {
  connected: boolean
  login: string
  name: string
  avatar_url: string
  scope: string
  updated_at: string | null
}

export interface GitHubOAuthStart {
  authorize_url: string
}

export interface GitHubDeviceStart {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export interface GitHubDevicePoll {
  status: 'pending' | 'slow_down' | 'connected' | 'failed' | string
  error: string
  interval: number | null
  account: GitHubAccountStatus | null
}

export interface GitHubImportResult {
  project_id: string
  repo_url: string
  branch: string
  doc_count: number
  file_count: number
  byte_count: number
}

export interface GitHubPushResult {
  project_id: string
  repo_url: string
  branch: string
  commit_sha: string
  pushed: boolean
}

export const githubApi = {
  account: () => http<GitHubAccountStatus>('/api/github/account', { scope: 'global' }),
  startOAuth: () =>
    http<GitHubOAuthStart>('/api/github/oauth/start', { method: 'POST', scope: 'global' }),
  startDevice: (clientId?: string) =>
    http<GitHubDeviceStart>('/api/github/device/start', {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId || null, scope: 'repo' }),
      scope: 'global',
    }),
  pollDevice: (deviceCode: string, clientId?: string) =>
    http<GitHubDevicePoll>('/api/github/device/poll', {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId || null, device_code: deviceCode }),
      scope: 'global',
    }),
  connectToken: (token: string) =>
    http<GitHubAccountStatus>('/api/github/token', {
      method: 'POST',
      body: JSON.stringify({ token }),
      scope: 'global',
    }),
  disconnect: () =>
    http<void>('/api/github/account', { method: 'DELETE', scope: 'global' }),
}

export const projectArchiveApi = {
  status: (projectId: string) =>
    http<ProjectArchiveStatus>(`/api/projects/${encodeURIComponent(projectId)}/archive/status`, {
      scope: 'global',
    }),
  configureGithub: (projectId: string, draft: ProjectArchiveBindingDraft) =>
    http<ProjectArchiveBinding>(`/api/projects/${encodeURIComponent(projectId)}/archive/github`, {
      method: 'PUT',
      body: JSON.stringify(draft),
      scope: 'global',
    }),
  createSnapshot: (projectId: string, message?: string) =>
    http<ProjectArchiveSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/archive/snapshots`, {
      method: 'POST',
      body: JSON.stringify({ message }),
      scope: 'global',
    }),
  listSnapshots: (projectId: string) =>
    http<ProjectArchiveSnapshot[]>(`/api/projects/${encodeURIComponent(projectId)}/archive/snapshots`, {
      scope: 'global',
    }),
  importGithub: (projectId: string, repoUrl: string, branch?: string) =>
    http<GitHubImportResult>(`/api/projects/${encodeURIComponent(projectId)}/archive/github/import`, {
      method: 'POST',
      body: JSON.stringify({ repo_url: repoUrl, branch: branch || null }),
      scope: 'global',
    }),
  pushGithub: (projectId: string, message?: string) =>
    http<GitHubPushResult>(`/api/projects/${encodeURIComponent(projectId)}/archive/github/push`, {
      method: 'POST',
      body: JSON.stringify({ message }),
      scope: 'global',
    }),
}

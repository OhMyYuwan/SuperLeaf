/**
 * Workflow 定义、运行与测试用例相关 API。
 */

import { http, BASE } from './client'

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
  source_text: string
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
  // Canvas-generated graphs use 'agent' (team or inline config), 'loop'
  // (container), and 'input' / 'output' (workflow boundary nodes).
  // 'inline-agent' is accepted for legacy/imported JSON and normalized by
  // the canvas back to type='agent' + config.agent_source='inline'.
  // Legacy modes (parallel/pipeline/roundtable) may still carry other values.
  type: 'agent' | 'inline-agent' | 'loop' | 'input' | 'output' | 'workflow' | 'merge' | 'judge'
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

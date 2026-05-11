/**
 * workflowStore — mirrors /api/workflows and tracks in-flight runs.
 *
 * Streaming note: EventSource only supports GET; our /run endpoint is POST
 * (it carries a selection body). We therefore do a plain fetch and parse the
 * SSE manually from the ReadableStream.
 *
 * On `ylw.run.finished` we parse the outputs and hand them off to
 * annotationStore, so the panel + decorations can render. On `ylw.run.failed`
 * we fall back gracefully so the user still sees what went wrong.
 */

import { create } from 'zustand'
import {
  workflowApi,
  workflowDefinitionApi,
  buildHeaders,
  type CachedWorkflow,
  type RunRequest,
  type WorkflowRun,
  type WorkflowDefinition,
  type WorkflowDefinitionDraft,
} from '../services/backendApi'
import { useAnnotationStore } from './annotationStore'
import { useDocumentStore } from './documentStore'
import { parseDifyOutputs } from '../services/outputParser'

export type RunEventKind =
  | 'ylw.run.started'
  | 'ylw.run.finished'
  | 'ylw.run.failed'
  | 'workflow.started'
  | 'workflow.completed'
  | 'workflow.merged'
  | 'node.started'
  | 'node.completed'
  | 'node.failed'
  | 'round.started'
  | 'round.completed'
  | 'roundtable.converged'
  | 'dify'
  | 'nanobot'

export interface RunEvent {
  kind: RunEventKind
  payload: unknown
  at: number
}

export interface NodeStatus {
  nodeId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  startTime?: number
  endTime?: number
  input?: string
  output?: string
  error?: string
}

interface InFlight {
  workflowId: string
  documentId: string
  range: { from: number; to: number }
  selectionText: string
  // Card whose follow-up (Continue) triggered this run, if any.
  threadCardId?: string
  // true => terminal workflow result should be ingested into annotationStore.
  // This is the default path for running a workflow from the annotation column
  // or the workflow tab. Discussion/chat flows will explicitly turn it off.
  autoIngestToAnnotations?: boolean
}

interface WorkflowState {
  workflows: CachedWorkflow[]
  loading: boolean
  loaded: boolean
  error: string | null

  running: Record<string, boolean>
  lastRunEvents: Record<string, RunEvent[]>

  // Persisted run history (loaded on demand from /api/workflows/runs)
  runHistory: WorkflowRun[]
  historyLoading: boolean
  historyError: string | null

  // Workflow definitions (orchestrated multi-agent workflows)
  definitions: WorkflowDefinition[]
  definitionsLoading: boolean
  definitionsLoaded: boolean
  definitionsError: string | null

  // Node-level status tracking for orchestrated runs
  nodeStatuses: Record<string, NodeStatus[]>
  currentRound: Record<string, number>
  maxRounds: Record<string, number>

  load: () => Promise<void>
  run: (workflowId: string, body: RunRequest, opts?: { threadCardId?: string; autoIngestToAnnotations?: boolean }) => Promise<void>
  loadHistory: (filter?: { documentId?: string; workflowId?: string }) => Promise<void>
  deleteRun: (runId: string) => Promise<void>
  disableWorkflow: (workflowId: string) => Promise<void>
  enableWorkflow: (workflowId: string) => Promise<void>

  // Workflow definition management
  loadDefinitions: () => Promise<void>
  createDefinition: (draft: WorkflowDefinitionDraft) => Promise<WorkflowDefinition>
  updateDefinition: (id: string, draft: WorkflowDefinitionDraft) => Promise<WorkflowDefinition>
  deleteDefinition: (id: string) => Promise<void>
  executeDefinition: (definitionId: string, body: RunRequest, opts?: ExecuteDefinitionOpts) => Promise<void>
}

/** Optional callbacks for workflow definition execution. */
export interface ExecuteDefinitionOpts {
  autoIngestToAnnotations?: boolean
  /** Fired when the terminal `workflow.completed` event arrives. `summary`
   *  is the best-effort user-facing blurb extracted from outputs. */
  onCompleted?: (summary: string, outputs: unknown) => void
  /** Fired when the run fails (network error, orchestrator error). */
  onFailed?: (error: string) => void
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  workflows: [],
  loading: false,
  loaded: false,
  error: null,
  running: {},
  lastRunEvents: {},
  runHistory: [],
  historyLoading: false,
  historyError: null,
  definitions: [],
  definitionsLoading: false,
  definitionsLoaded: false,
  definitionsError: null,
  nodeStatuses: {},
  currentRound: {},
  maxRounds: {},

  load: async () => {
    set({ loading: true, error: null })
    try {
      const workflows = await workflowApi.list()
      set({ workflows, loading: false, loaded: true })
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) })
    }
  },

  loadHistory: async (filter) => {
    set({ historyLoading: true, historyError: null })
    try {
      const runHistory = await workflowApi.listRuns({
        document_id: filter?.documentId,
        workflow_id: filter?.workflowId,
        limit: 100,
      })
      set({ runHistory, historyLoading: false })
    } catch (e) {
      set({
        historyLoading: false,
        historyError: e instanceof Error ? e.message : String(e),
      })
    }
  },

  deleteRun: async (runId) => {
    try {
      await workflowApi.deleteRun(runId)
      set((s) => ({ runHistory: s.runHistory.filter((r) => r.id !== runId) }))
    } catch (e) {
      set({ historyError: e instanceof Error ? e.message : String(e) })
    }
  },

  disableWorkflow: async (workflowId) => {
    try {
      const updated = await workflowApi.disable(workflowId)
      set((s) => ({
        workflows: s.workflows.map((w) => (w.id === workflowId ? updated : w)),
      }))
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  enableWorkflow: async (workflowId) => {
    try {
      const updated = await workflowApi.enable(workflowId)
      set((s) => ({
        workflows: s.workflows.map((w) => (w.id === workflowId ? updated : w)),
      }))
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  loadDefinitions: async () => {
    set({ definitionsLoading: true, definitionsError: null })
    try {
      const definitions = await workflowDefinitionApi.list()
      set({ definitions, definitionsLoading: false, definitionsLoaded: true })
    } catch (e) {
      set({
        definitionsLoading: false,
        definitionsLoaded: true,
        definitionsError: e instanceof Error ? e.message : String(e),
      })
    }
  },

  createDefinition: async (draft) => {
    try {
      const created = await workflowDefinitionApi.create(draft)
      set((s) => ({ definitions: [...s.definitions, created] }))
      return created
    } catch (e) {
      set({ definitionsError: e instanceof Error ? e.message : String(e) })
      throw e
    }
  },

  updateDefinition: async (id, draft) => {
    try {
      const updated = await workflowDefinitionApi.update(id, draft)
      set((s) => ({
        definitions: s.definitions.map((d) => (d.id === id ? updated : d)),
      }))
      return updated
    } catch (e) {
      set({ definitionsError: e instanceof Error ? e.message : String(e) })
      throw e
    }
  },

  deleteDefinition: async (id) => {
    try {
      await workflowDefinitionApi.delete(id)
      set((s) => ({ definitions: s.definitions.filter((d) => d.id !== id) }))
    } catch (e) {
      set({ definitionsError: e instanceof Error ? e.message : String(e) })
    }
  },

  executeDefinition: async (definitionId, body, opts) => {
    const def = get().definitions.find((d) => d.id === definitionId)
    const doc = useDocumentStore.getState().documents[body.document_id]
    const inflight: InFlight = {
      workflowId: definitionId,
      documentId: body.document_id,
      range: { from: body.range_start, to: body.range_end },
      selectionText: doc ? doc.content.slice(body.range_start, body.range_end) : '',
      autoIngestToAnnotations: opts?.autoIngestToAnnotations ?? true,
    }

    set((s) => ({
      running: { ...s.running, [definitionId]: true },
      lastRunEvents: { ...s.lastRunEvents, [definitionId]: [] },
      nodeStatuses: { ...s.nodeStatuses, [definitionId]: [] },
      currentRound: { ...s.currentRound, [definitionId]: 0 },
      maxRounds: { ...s.maxRounds, [definitionId]: def?.config?.max_rounds ?? 3 },
    }))

    const timeoutMs = Number(import.meta.env?.VITE_REQUEST_TIMEOUT_MS ?? 30000)
    const abortCtl = new AbortController()
    const firstByteTimer = setTimeout(() => abortCtl.abort('timeout'), timeoutMs)

    try {
      const headers = buildHeaders({ Accept: 'text/event-stream' })
      const resp = await fetch(workflowDefinitionApi.executeStreamUrl(definitionId), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortCtl.signal,
      })
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => resp.statusText)
        throw new Error(formatExecuteError(resp.status, text))
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      let gotFirstChunk = false
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!gotFirstChunk) {
          clearTimeout(firstByteTimer)
          gotFirstChunk = true
        }
        buf += decoder.decode(value, { stream: true })
        let boundary = findEventBoundary(buf)
        while (boundary !== null) {
          const chunk = buf.slice(0, boundary.start)
          buf = buf.slice(boundary.end)
          const parsed = parseSseMessage(chunk)
          if (parsed) {
            pushEvent(set, definitionId, parsed)
            handleOrchestratedEvent(set, definitionId, parsed, inflight, def?.name ?? definitionId, opts)
          }
          boundary = findEventBoundary(buf)
        }
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      const msg = aborted
        ? `Workflow 响应超时（${timeoutMs / 1000}s 内无数据）`
        : e instanceof Error ? e.message : String(e)
      pushEvent(set, definitionId, {
        kind: 'ylw.run.failed',
        payload: { error: msg },
        at: Date.now(),
      })
      opts?.onFailed?.(msg)
    } finally {
      clearTimeout(firstByteTimer)
      set((s) => ({ running: { ...s.running, [definitionId]: false } }))
    }
  },

  run: async (workflowId, body, opts) => {
    const wf = get().workflows.find((w) => w.id === workflowId)
    const doc = useDocumentStore.getState().documents[body.document_id]
    const inflight: InFlight = {
      workflowId,
      documentId: body.document_id,
      range: { from: body.range_start, to: body.range_end },
      selectionText: doc ? doc.content.slice(body.range_start, body.range_end) : '',
      threadCardId: opts?.threadCardId,
      autoIngestToAnnotations:
        opts?.autoIngestToAnnotations ?? (opts?.threadCardId ? false : true),
    }

    set((s) => ({
      running: { ...s.running, [workflowId]: true },
      lastRunEvents: { ...s.lastRunEvents, [workflowId]: [] },
    }))
    // eslint-disable-next-line no-console
    console.log('[workflow.run] dispatching', { workflowId, body })

    const timeoutMs = Number(import.meta.env?.VITE_REQUEST_TIMEOUT_MS ?? 30000)
    const abortCtl = new AbortController()
    const firstByteTimer = setTimeout(() => abortCtl.abort('timeout'), timeoutMs)

    try {
      const headers = buildHeaders({ Accept: 'text/event-stream' })
      const resp = await fetch(workflowApi.runStreamUrl(workflowId), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortCtl.signal,
      })
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => resp.statusText)
        // eslint-disable-next-line no-console
        console.error('[workflow.run] backend error', resp.status, text)
        throw new Error(`后端返回 ${resp.status}: ${text?.slice(0, 300) || resp.statusText}`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      let gotFirstChunk = false
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!gotFirstChunk) {
          clearTimeout(firstByteTimer)
          gotFirstChunk = true
        }
        buf += decoder.decode(value, { stream: true })
        // SSE separates events with a blank line. Be liberal: servers use
        // either "\n\n" or "\r\n\r\n".
        let boundary = findEventBoundary(buf)
        while (boundary !== null) {
          const chunk = buf.slice(0, boundary.start)
          buf = buf.slice(boundary.end)
          const parsed = parseSseMessage(chunk)
          if (parsed) {
            // eslint-disable-next-line no-console
            console.log('[sse]', parsed.kind, parsed.payload)
            pushEvent(set, workflowId, parsed)
            handleTerminalEvent(parsed, inflight, wf?.name ?? workflowId)
          }
          boundary = findEventBoundary(buf)
        }
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      const msg = aborted
        ? `Agent 响应超时（${timeoutMs / 1000}s 内无数据），请重试或检查 Provider`
        : e instanceof Error ? e.message : String(e)
      pushEvent(set, workflowId, {
        kind: 'ylw.run.failed',
        payload: { error: msg },
        at: Date.now(),
      })
    } finally {
      clearTimeout(firstByteTimer)
      set((s) => ({ running: { ...s.running, [workflowId]: false } }))
    }
  },
}))

function findEventBoundary(buf: string): { start: number; end: number } | null {
  const crlf = buf.indexOf('\r\n\r\n')
  const lf = buf.indexOf('\n\n')
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { start: crlf, end: crlf + 4 }
  }
  if (lf !== -1) {
    return { start: lf, end: lf + 2 }
  }
  return null
}

function parseSseMessage(chunk: string): RunEvent | null {
  let eventName = 'message'
  const dataLines: string[] = []
  // Normalize \r\n -> \n so line parsing is consistent whether the server
  // emits CRLF (sse-starlette's default) or LF.
  const normalized = chunk.replace(/\r\n/g, '\n')
  for (const line of normalized.split('\n')) {
    if (!line) continue
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = raw
  }
  const kind = (eventName as RunEventKind) ?? 'dify'
  return { kind, payload, at: Date.now() }
}

function pushEvent(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  workflowId: string,
  evt: RunEvent,
) {
  set((s) => ({
    lastRunEvents: {
      ...s.lastRunEvents,
      [workflowId]: [...(s.lastRunEvents[workflowId] ?? []), evt],
    },
  }))
}

interface FinishedPayload {
  run_id: string
  outputs: unknown
  conversation_id?: string
  mode?: string
}

function handleTerminalEvent(evt: RunEvent, inflight: InFlight, agentName: string) {
  if (evt.kind === 'ylw.run.finished') {
    const payload = evt.payload as FinishedPayload
    const parsed = parseDifyOutputs(payload.outputs, {
      range: inflight.range,
      selectionText: inflight.selectionText,
    })
    // eslint-disable-next-line no-console
    console.log('[workflow.finished]', {
      runId: payload.run_id,
      outputs: payload.outputs,
      parsed,
      range: inflight.range,
      threadCardId: inflight.threadCardId,
      autoIngestToAnnotations: inflight.autoIngestToAnnotations,
    })

    const ann = useAnnotationStore.getState()

    if (inflight.threadCardId) {
      // Continue mode: append the answer to the existing card's thread.
      const text = parsed.rawText || extractFirstSummary(parsed)
      if (text) {
        ann.appendThread(inflight.threadCardId, { role: 'agent', content: text })
      }
      if (payload.conversation_id) {
        ann.setConversationId(inflight.threadCardId, payload.conversation_id)
      }
      return
    }

    if (!inflight.autoIngestToAnnotations) {
      return
    }

    ann.ingestRun({
      runId: payload.run_id,
      workflowId: inflight.workflowId,
      documentId: inflight.documentId,
      agentName,
      conversationId: payload.conversation_id,
      parsed,
    })
    // eslint-disable-next-line no-console
    console.log('[workflow.finished] store after ingest, item count =', Object.keys(useAnnotationStore.getState().items).length)
  }
  if (evt.kind === 'ylw.run.failed') {
    // eslint-disable-next-line no-console
    console.error('[workflow.failed]', evt.payload)
  }
}

function extractFirstSummary(parsed: ReturnType<typeof parseDifyOutputs>): string {
  if (parsed.rawText) return parsed.rawText
  if (parsed.annotations[0]?.content) return parsed.annotations[0].content
  if (parsed.suggestions[0]?.proposed) return parsed.suggestions[0].proposed
  if (parsed.risks[0]?.description) return parsed.risks[0].description
  return ''
}

function handleOrchestratedEvent(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  definitionId: string,
  evt: RunEvent,
  inflight: InFlight,
  workflowName: string,
  opts?: ExecuteDefinitionOpts,
) {
  const payload = evt.payload as Record<string, unknown>

  if (evt.kind === 'node.started') {
    const nodeId = nodeIdFromPayload(payload)
    if (!nodeId) return
    const input = formatNodeJson(payload.input)
    set((s) => ({
      nodeStatuses: {
        ...s.nodeStatuses,
        [definitionId]: [
          ...(s.nodeStatuses[definitionId] ?? []).filter((n) => n.nodeId !== nodeId),
          { nodeId, status: 'running', startTime: Date.now(), input },
        ],
      },
    }))
  }

  if (evt.kind === 'node.completed') {
    const nodeId = nodeIdFromPayload(payload)
    if (!nodeId) return
    const input = formatNodeJson(payload.input)
    const output = formatNodeJson(payload.output)
    set((s) => ({
      nodeStatuses: {
        ...s.nodeStatuses,
        [definitionId]: upsertNodeStatus(s.nodeStatuses[definitionId] ?? [], {
          nodeId,
          status: 'completed',
          endTime: Date.now(),
          input,
          output,
        }),
      },
    }))
  }

  if (evt.kind === 'node.failed') {
    const nodeId = nodeIdFromPayload(payload)
    if (!nodeId) return
    const input = formatNodeJson(payload.input)
    const error = payload.error as string
    set((s) => ({
      nodeStatuses: {
        ...s.nodeStatuses,
        [definitionId]: upsertNodeStatus(s.nodeStatuses[definitionId] ?? [], {
          nodeId,
          status: 'failed',
          endTime: Date.now(),
          input,
          error,
        }),
      },
    }))
  }

  if (evt.kind === 'round.started') {
    const round = payload.round as number
    set((s) => ({
      currentRound: { ...s.currentRound, [definitionId]: round },
    }))
  }

  if (evt.kind === 'workflow.completed') {
    const outputs = payload.outputs as unknown
    const parsed = parseDifyOutputs(outputs, {
      range: inflight.range,
      selectionText: inflight.selectionText,
    })

    if (inflight.autoIngestToAnnotations) {
      const ann = useAnnotationStore.getState()
      ann.ingestRun({
        runId: payload.run_id as string,
        workflowId: definitionId,
        documentId: inflight.documentId,
        agentName: workflowName,
        conversationId: undefined,
        parsed,
      })
    }

    if (opts?.onCompleted) {
      const summary = extractFirstSummary(parsed) || parsed.rawText || ''
      opts.onCompleted(summary, outputs)
    }
  }

  if (evt.kind === 'ylw.run.failed') {
    // eslint-disable-next-line no-console
    console.error('[workflow.orchestrated.failed]', evt.payload)
    const err = (payload.error as string | undefined) ?? 'workflow failed'
    opts?.onFailed?.(err)
  }
}

function nodeIdFromPayload(payload: Record<string, unknown>): string {
  return String(payload.nodeId ?? payload.node_id ?? '')
}

function formatNodeJson(value: unknown): string {
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return JSON.stringify(String(value), null, 2)
  }
}

function upsertNodeStatus(nodes: NodeStatus[], patch: NodeStatus): NodeStatus[] {
  const idx = nodes.findIndex((n) => n.nodeId === patch.nodeId)
  if (idx === -1) return [...nodes, patch]
  return nodes.map((n, i) => (i === idx ? { ...n, ...patch } : n))
}

/**
 * Render a backend error body into a user-facing string. Backend returns
 * structured detail for 409 (degraded workflow / missing boundary); fall back
 * to raw text otherwise.
 */
function formatExecuteError(status: number, body: string): string {
  if (status === 409 && body) {
    try {
      const parsed = JSON.parse(body) as {
        detail?: {
          code?: string
          message?: string
          issues?: { node_id?: string; agent_id?: string; reason?: string }[]
          missing?: string[]
        }
      }
      const detail = parsed.detail
      if (detail?.code === 'workflow_degraded') {
        const msg = detail.message ?? 'Workflow 中存在不可用的 Agent'
        const list = (detail.issues ?? [])
          .map((i) => {
            const agent = i.agent_id ? `${i.agent_id.slice(0, 10)}…` : '未选择 Agent'
            return `  · ${i.node_id} → ${agent} (${i.reason})`
          })
          .join('\n')
        return list ? `${msg}\n${list}` : msg
      }
      if (detail?.code === 'workflow_missing_boundary') {
        const msg = detail.message ?? 'Workflow 缺少边界节点'
        const missing = (detail.missing ?? []).join(' / ')
        return missing ? `${msg}（缺少：${missing}）` : msg
      }
    } catch {
      /* fall through to raw */
    }
  }
  return `后端返回 ${status}: ${body?.slice(0, 300) || ''}`
}

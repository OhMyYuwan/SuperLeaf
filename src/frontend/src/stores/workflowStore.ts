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
  type CachedWorkflow,
  type RunRequest,
} from '../services/backendApi'
import { useAnnotationStore } from './annotationStore'
import { useDocumentStore } from './documentStore'
import { parseDifyOutputs } from '../services/outputParser'

export type RunEventKind =
  | 'ylw.run.started'
  | 'ylw.run.finished'
  | 'ylw.run.failed'
  | 'dify'

export interface RunEvent {
  kind: RunEventKind
  payload: unknown
  at: number
}

interface InFlight {
  workflowId: string
  documentId: string
  range: { from: number; to: number }
  selectionText: string
  // Card whose follow-up (Continue) triggered this run, if any.
  threadCardId?: string
}

interface WorkflowState {
  workflows: CachedWorkflow[]
  loading: boolean
  loaded: boolean
  error: string | null

  running: Record<string, boolean>
  lastRunEvents: Record<string, RunEvent[]>

  load: () => Promise<void>
  run: (workflowId: string, body: RunRequest, opts?: { threadCardId?: string }) => Promise<void>
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  workflows: [],
  loading: false,
  loaded: false,
  error: null,
  running: {},
  lastRunEvents: {},

  load: async () => {
    set({ loading: true, error: null })
    try {
      const workflows = await workflowApi.list()
      set({ workflows, loading: false, loaded: true })
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) })
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
    }

    set((s) => ({
      running: { ...s.running, [workflowId]: true },
      lastRunEvents: { ...s.lastRunEvents, [workflowId]: [] },
    }))
    // eslint-disable-next-line no-console
    console.log('[workflow.run] dispatching', { workflowId, body })
    try {
      const resp = await fetch(workflowApi.runStreamUrl(workflowId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
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
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
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
      pushEvent(set, workflowId, {
        kind: 'ylw.run.failed',
        payload: { error: e instanceof Error ? e.message : String(e) },
        at: Date.now(),
      })
    } finally {
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

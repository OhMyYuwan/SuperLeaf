import { BACKEND_BASE, type BrowserNanobotToolResult, type NanobotToolCall } from './backendApi'

export interface BrowserToolBridgeContextInput {
  contextId?: string
  contextSecret?: string
  projectId: string
  conversationId: string
  documentId: string
  rangeStart: number
  rangeEnd: number
  inputs: Record<string, unknown>
  superleafOrigin?: string
  backendUrl?: string
  contextMode?: string
  promptPolicy?: Record<string, unknown>
  providerId?: string
  providerName?: string
  documentName?: string
  documentFormat?: string
  selectionHash?: string
  selectionPreview?: string
  docVersion?: string | number
  toolSurface?: string
  toolManifestVersion?: string
  contextChanged?: string
  accessMode?: string
}

export interface BrowserToolBridgeContext {
  status: string
  context_id: string
  context_secret: string
  mcp_url: string
  tool_count: number
  resource_count?: number
  prompt_count?: number
  expires_at: number
  // Recovery hints from the server (present after a reconnect): how many tool
  // calls are still awaiting a result for this conversation. resuming=true means
  // an agent turn was in flight when this browser (re)connected.
  pending_calls?: number
  in_flight?: number
  resuming?: boolean
}

export interface BrowserToolBridgeRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
  agent_name: string
  context_id: string
  project_id: string
  conversation_id: string
  document_id: string
  range_start: number
  range_end: number
  inputs: Record<string, unknown>
  created_at: string
}

export interface BrowserToolBridgeApprovalRequest {
  id: string
  method: string
  title: string
  summary: string
  detail: string
  tool_name: string
  context_id: string
  context_secret: string
  project_id: string
  conversation_id: string
  document_id: string
  created_at: string
  expires_at: number
}

export interface BrowserToolCallContext {
  contextId?: string
  projectId?: string
  conversationId: string
  documentId: string
  rangeStart: number
  rangeEnd: number
  inputs: Record<string, unknown>
}

export interface BrowserToolBridgeResult {
  content: string
  failed: boolean
  name: string
  toolKind?: string
  events?: Array<{ event: string; data: unknown }>
  model_visible?: Record<string, unknown>
  ui_meta?: Record<string, unknown>
  audit?: Record<string, unknown>
}

export interface BrowserToolBridgeHandle {
  context: BrowserToolBridgeContext
  stop: () => void
}

export interface StartBrowserToolBridgeArgs {
  endpoint: string
  context: BrowserToolBridgeContextInput
  parentSignal: AbortSignal
  executeRequest: (
    request: BrowserToolBridgeRequest,
    signal: AbortSignal,
  ) => Promise<BrowserToolBridgeResult | BrowserNanobotToolResult>
  waitMs?: number
  refreshMs?: number
  requestTimeoutMs?: number
  onActivity?: () => void
  onPollError?: (err: unknown) => void
  onRequestError?: (request: BrowserToolBridgeRequest, err: unknown) => void
  onRefreshError?: (err: unknown) => void
  onApprovalRequest?: (request: BrowserToolBridgeApprovalRequest) => void
  onApprovalPollError?: (err: unknown) => void
}

export async function startBrowserToolBridge(
  args: StartBrowserToolBridgeArgs,
): Promise<BrowserToolBridgeHandle> {
  const context = await registerBrowserToolBridgeContext({
    endpoint: args.endpoint,
    context: args.context,
  })
  let contextId = context.context_id
  let contextSecret = context.context_secret
  args.onActivity?.()

  const ctl = new AbortController()
  const stop = () => ctl.abort('stopped')
  if (args.parentSignal.aborted) stop()
  else args.parentSignal.addEventListener('abort', stop, { once: true })

  // Re-register the context to extend its server-side TTL and recover its
  // context_id after any blip. Shared by the periodic heartbeat and the
  // tab-visibility handler below.
  const heartbeat = () => {
    if (ctl.signal.aborted) return
    registerBrowserToolBridgeContext({
      endpoint: args.endpoint,
      context: {
        ...args.context,
        contextId,
        contextSecret,
      },
      signal: ctl.signal,
    })
      .then((refreshed) => {
        contextId = refreshed.context_id
        contextSecret = refreshed.context_secret || contextSecret
        args.onActivity?.()
      })
      .catch((err) => {
        if (!ctl.signal.aborted) args.onRefreshError?.(err)
      })
  }

  const refreshMs = Math.max(0, args.refreshMs ?? 60000)
  const refreshTimer = refreshMs > 0 ? window.setInterval(heartbeat, refreshMs) : 0

  // Background tabs get setInterval throttled (often to >=1/min), so a long
  // background period can let the context TTL lapse. Fire an immediate heartbeat
  // when the tab becomes visible again to close that gap. Guarded for non-DOM
  // environments (SSR/tests).
  const canListen =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  const onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') heartbeat()
  }
  const onOnline = () => heartbeat()
  if (canListen) {
    window.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
  }

  void runBrowserToolBridgeLoop({
    ...args,
    contextId,
    contextSecret,
    signal: ctl.signal,
  })
  if (args.onApprovalRequest) {
    void runBrowserApprovalBridgeLoop({
      ...args,
      contextId,
      contextSecret,
      signal: ctl.signal,
    })
  }

  return {
    context,
    stop: () => {
      args.parentSignal.removeEventListener('abort', stop)
      if (refreshTimer) window.clearInterval(refreshTimer)
      if (canListen && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('visibilitychange', onVisible)
        window.removeEventListener('online', onOnline)
      }
      stop()
    },
  }
}

export async function registerBrowserToolBridgeContext(args: {
  endpoint: string
  context: BrowserToolBridgeContextInput
  signal?: AbortSignal
}): Promise<BrowserToolBridgeContext> {
  const resp = await fetch(`${normalizeLocalAgentHostEndpoint(args.endpoint)}/superleaf/mcp/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context_id: args.context.contextId ?? '',
      context_secret: args.context.contextSecret ?? '',
      project_id: args.context.projectId,
      conversation_id: args.context.conversationId,
      document_id: args.context.documentId,
      range_start: args.context.rangeStart,
      range_end: args.context.rangeEnd,
      inputs: args.context.inputs,
      superleaf_origin: args.context.superleafOrigin ?? window.location.origin,
      backend_url: args.context.backendUrl ?? BACKEND_BASE,
      context_mode: args.context.contextMode ?? '',
      prompt_policy: args.context.promptPolicy ?? {},
      provider_id: args.context.providerId ?? '',
      provider_name: args.context.providerName ?? '',
      document_name: args.context.documentName ?? '',
      document_format: args.context.documentFormat ?? '',
      selection_hash: args.context.selectionHash ?? '',
      selection_preview: args.context.selectionPreview ?? '',
      doc_version: args.context.docVersion ?? '',
      tool_surface: args.context.toolSurface ?? '',
      tool_manifest_version: args.context.toolManifestVersion ?? '',
      context_changed: args.context.contextChanged ?? '',
      access_mode: args.context.accessMode ?? '',
    }),
    signal: args.signal,
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`SuperLeaf MCP context ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  return payload as unknown as BrowserToolBridgeContext
}

export async function pollBrowserToolBridgeRequests(args: {
  endpoint: string
  contextId: string
  contextSecret: string
  signal?: AbortSignal
  waitMs?: number
}): Promise<BrowserToolBridgeRequest[]> {
  const url = new URL(`${normalizeLocalAgentHostEndpoint(args.endpoint)}/superleaf/mcp/tool-requests`)
  url.searchParams.set('context_id', args.contextId)
  url.searchParams.set('context_secret', args.contextSecret)
  url.searchParams.set('wait_ms', String(args.waitMs ?? 25000))
  const resp = await fetch(url.toString(), {
    method: 'GET',
    signal: args.signal,
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`SuperLeaf MCP poll ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  return Array.isArray(payload.requests)
    ? payload.requests.map(normalizeBridgeToolRequest).filter((item): item is BrowserToolBridgeRequest => Boolean(item))
    : []
}

export async function submitBrowserToolBridgeResult(args: {
  endpoint: string
  requestId: string
  contextSecret: string
  content: string
  failed: boolean
  name: string
  toolKind?: string
  events?: Array<{ event: string; data: unknown }>
  modelVisible?: Record<string, unknown>
  uiMeta?: Record<string, unknown>
  audit?: Record<string, unknown>
  signal?: AbortSignal
}): Promise<void> {
  const resp = await fetch(`${normalizeLocalAgentHostEndpoint(args.endpoint)}/superleaf/mcp/tool-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: args.requestId,
      context_secret: args.contextSecret,
      content: args.content,
      failed: args.failed,
      name: args.name,
      tool_kind: args.toolKind ?? '',
      events: args.events ?? [],
      model_visible: args.modelVisible ?? {},
      ui_meta: args.uiMeta ?? {},
      audit: args.audit ?? {},
    }),
    signal: args.signal,
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`SuperLeaf MCP result ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
}

export async function pollBrowserToolBridgeApprovalRequests(args: {
  endpoint: string
  contextId: string
  contextSecret: string
  signal?: AbortSignal
  waitMs?: number
}): Promise<BrowserToolBridgeApprovalRequest[]> {
  const url = new URL(`${normalizeLocalAgentHostEndpoint(args.endpoint)}/superleaf/mcp/approval-requests`)
  url.searchParams.set('context_id', args.contextId)
  url.searchParams.set('context_secret', args.contextSecret)
  url.searchParams.set('wait_ms', String(args.waitMs ?? 25000))
  const resp = await fetch(url.toString(), {
    method: 'GET',
    signal: args.signal,
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`SuperLeaf approval poll ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  return Array.isArray(payload.requests)
    ? payload.requests.map(normalizeBridgeApprovalRequest).filter((item): item is BrowserToolBridgeApprovalRequest => Boolean(item))
    : []
}

export async function submitBrowserToolBridgeApprovalResult(args: {
  endpoint: string
  requestId: string
  contextSecret: string
  decision: 'accept' | 'reject'
  signal?: AbortSignal
}): Promise<void> {
  const resp = await fetch(`${normalizeLocalAgentHostEndpoint(args.endpoint)}/superleaf/mcp/approval-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: args.requestId,
      context_secret: args.contextSecret,
      decision: args.decision,
    }),
    signal: args.signal,
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`SuperLeaf approval result ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
}

export function normalizeLocalAgentHostEndpoint(endpoint: string): string {
  const cleaned = endpoint.trim().replace(/\s+/gu, '').replace(/\/+$/u, '')
  return cleaned || 'http://127.0.0.1:8787'
}

export function bridgeRequestFromToolCall(
  toolCall: NanobotToolCall,
  context: BrowserToolCallContext,
): BrowserToolBridgeRequest {
  const id = toolCall.id?.trim() || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const name = toolCall.function?.name?.trim() || 'tool'
  return {
    id,
    name,
    arguments: parseToolCallArguments(toolCall.function?.arguments),
    agent_name: '',
    context_id: context.contextId || `browser_${context.conversationId}`,
    project_id: context.projectId ?? '',
    conversation_id: context.conversationId,
    document_id: context.documentId,
    range_start: context.rangeStart,
    range_end: context.rangeEnd,
    inputs: context.inputs,
    created_at: new Date().toISOString(),
  }
}

export function toolCallFromBridgeRequest(request: BrowserToolBridgeRequest): NanobotToolCall {
  return {
    id: request.id,
    type: 'function',
    function: {
      name: request.name,
      arguments: JSON.stringify(request.arguments ?? {}),
    },
  }
}

async function runBrowserToolBridgeLoop(
  args: StartBrowserToolBridgeArgs & { contextId: string; contextSecret: string; signal: AbortSignal },
): Promise<void> {
  let contextId = args.contextId
  let contextSecret = args.contextSecret
  // Backoff state for repeated poll failures (server down, network lost). Reset
  // to 0 on any successful poll so transient blips don't accumulate delay.
  let consecutiveFailures = 0
  // Wakes the loop out of its backoff sleep the instant connectivity or tab
  // visibility is restored, so recovery is immediate rather than waiting out the
  // current backoff interval.
  const wake = createWakeSignal(args.signal)
  while (!args.signal.aborted) {
    let requests: BrowserToolBridgeRequest[] = []
    try {
      requests = await pollBrowserToolBridgeRequests({
        endpoint: args.endpoint,
        contextId,
        contextSecret,
        signal: args.signal,
        waitMs: args.waitMs,
      })
      consecutiveFailures = 0
    } catch (err) {
      if (args.signal.aborted) break
      args.onPollError?.(err)
      try {
        const refreshed = await registerBrowserToolBridgeContext({
          endpoint: args.endpoint,
          context: {
            ...args.context,
            contextId,
            contextSecret,
          },
          signal: args.signal,
        })
        contextId = refreshed.context_id
        contextSecret = refreshed.context_secret || contextSecret
        args.onActivity?.()
      } catch (refreshErr) {
        if (!args.signal.aborted) args.onRefreshError?.(refreshErr)
      }
      consecutiveFailures += 1
      // Exponential backoff capped at 8s, woken early by online/visibility events.
      const backoff = Math.min(8000, 500 * 2 ** Math.min(consecutiveFailures - 1, 4))
      await sleepOrWake(backoff, wake, args.signal)
      continue
    }

    for (const request of requests) {
      if (args.signal.aborted) break
      await executeAndSubmitBridgeRequest(args, request)
    }
  }
  wake.dispose()
}

async function runBrowserApprovalBridgeLoop(
  args: StartBrowserToolBridgeArgs & { contextId: string; contextSecret: string; signal: AbortSignal },
): Promise<void> {
  let contextId = args.contextId
  let contextSecret = args.contextSecret
  let consecutiveFailures = 0
  const wake = createWakeSignal(args.signal)
  while (!args.signal.aborted) {
    let requests: BrowserToolBridgeApprovalRequest[] = []
    try {
      requests = await pollBrowserToolBridgeApprovalRequests({
        endpoint: args.endpoint,
        contextId,
        contextSecret,
        signal: args.signal,
        waitMs: args.waitMs,
      })
      consecutiveFailures = 0
    } catch (err) {
      if (args.signal.aborted) break
      args.onApprovalPollError?.(err)
      try {
        const refreshed = await registerBrowserToolBridgeContext({
          endpoint: args.endpoint,
          context: {
            ...args.context,
            contextId,
            contextSecret,
          },
          signal: args.signal,
        })
        contextId = refreshed.context_id
        contextSecret = refreshed.context_secret || contextSecret
        args.onActivity?.()
      } catch (refreshErr) {
        if (!args.signal.aborted) args.onRefreshError?.(refreshErr)
      }
      consecutiveFailures += 1
      const backoff = Math.min(8000, 500 * 2 ** Math.min(consecutiveFailures - 1, 4))
      await sleepOrWake(backoff, wake, args.signal)
      continue
    }

    if (requests.length > 0) args.onActivity?.()
    for (const request of requests) {
      if (args.signal.aborted) break
      args.onApprovalRequest?.({
        ...request,
        context_secret: contextSecret,
      })
    }
    if (requests.length > 0) await sleep(1000)
  }
  wake.dispose()
}

async function executeAndSubmitBridgeRequest(
  args: StartBrowserToolBridgeArgs & { contextSecret: string; signal: AbortSignal },
  request: BrowserToolBridgeRequest,
): Promise<void> {
  const requestTimeoutMs = Math.max(1000, args.requestTimeoutMs ?? 105000)
  const requestCtl = new AbortController()
  let timedOut = false
  const abortRequest = () => requestCtl.abort(args.signal.reason ?? 'stopped')
  if (args.signal.aborted) abortRequest()
  else args.signal.addEventListener('abort', abortRequest, { once: true })
  const timeout = window.setTimeout(() => {
    timedOut = true
    requestCtl.abort(new DOMException(`SuperLeaf MCP browser tool ${request.name} timed out after ${requestTimeoutMs}ms`, 'TimeoutError'))
  }, requestTimeoutMs)
  try {
    const result = await args.executeRequest(request, requestCtl.signal)
    const toolKind = 'tool_kind' in result ? result.tool_kind : result.toolKind
    args.onActivity?.()
    await submitBrowserToolBridgeResult({
      endpoint: args.endpoint,
      requestId: request.id,
      contextSecret: args.contextSecret,
      content: result.content,
      failed: result.failed,
      name: result.name || request.name,
      toolKind,
      events: result.events ?? [],
      modelVisible: result.model_visible ?? {},
      uiMeta: result.ui_meta ?? {},
      audit: result.audit ?? {},
      signal: args.signal,
    })
  } catch (err) {
    if (args.signal.aborted) return
    const normalizedError = timedOut
      ? new Error(`SuperLeaf MCP browser tool ${request.name} timed out after ${Math.round(requestTimeoutMs / 1000)}s while waiting for the SuperLeaf backend/browser bridge result.`)
      : err
    args.onRequestError?.(request, normalizedError)
    await submitBrowserToolBridgeResult({
      endpoint: args.endpoint,
      requestId: request.id,
      contextSecret: args.contextSecret,
      content: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
      failed: true,
      name: request.name,
      toolKind: 'superleaf_mcp',
      events: [],
      signal: args.signal,
    }).catch(() => undefined)
  } finally {
    window.clearTimeout(timeout)
    args.signal.removeEventListener('abort', abortRequest)
  }
}

async function readJson(resp: Response): Promise<Record<string, unknown>> {
  const text = await resp.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { text }
  }
}

function normalizeBridgeToolRequest(value: unknown): BrowserToolBridgeRequest | null {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const id = stringValue(raw.id)
  const name = stringValue(raw.name)
  const contextId = stringValue(raw.context_id)
  if (!id || !name || !contextId) return null
  return {
    id,
    name,
    arguments: raw.arguments && typeof raw.arguments === 'object'
      ? raw.arguments as Record<string, unknown>
      : {},
    agent_name: stringValue(raw.agent_name),
    context_id: contextId,
    project_id: stringValue(raw.project_id),
    conversation_id: stringValue(raw.conversation_id),
    document_id: stringValue(raw.document_id),
    range_start: Number(raw.range_start || 0),
    range_end: Number(raw.range_end || 0),
    inputs: raw.inputs && typeof raw.inputs === 'object' ? raw.inputs as Record<string, unknown> : {},
    created_at: stringValue(raw.created_at),
  }
}

function normalizeBridgeApprovalRequest(value: unknown): BrowserToolBridgeApprovalRequest | null {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const id = stringValue(raw.id)
  const contextId = stringValue(raw.context_id)
  if (!id || !contextId) return null
  return {
    id,
    method: stringValue(raw.method),
    title: stringValue(raw.title) || 'Codex 请求确认',
    summary: stringValue(raw.summary),
    detail: stringValue(raw.detail),
    tool_name: stringValue(raw.tool_name),
    context_id: contextId,
    context_secret: stringValue(raw.context_secret),
    project_id: stringValue(raw.project_id),
    conversation_id: stringValue(raw.conversation_id),
    document_id: stringValue(raw.document_id),
    created_at: stringValue(raw.created_at),
    expires_at: Number(raw.expires_at || 0),
  }
}

function stringError(payload: Record<string, unknown>): string {
  return String(payload.message || payload.error || payload.text || '')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseToolCallArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

interface WakeSignal {
  /** Promise that resolves the next time a wake event (online/visible) fires. */
  next: () => Promise<void>
  dispose: () => void
}

// Bridges browser connectivity/visibility events into the poll loop's backoff
// sleep. When the network comes back or the tab is refocused, any in-progress
// backoff is cut short so reconnection is immediate. Degrades to a no-op source
// (sleep runs to full duration) in environments without window event support
// (SSR, unit tests), so callers never need to branch on environment.
function createWakeSignal(parentSignal: AbortSignal): WakeSignal {
  const canListen =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  let resolvers: Array<() => void> = []
  const fire = () => {
    const pending = resolvers
    resolvers = []
    for (const resolve of pending) resolve()
  }
  const onOnline = () => fire()
  const onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') fire()
  }
  if (canListen) {
    window.addEventListener('online', onOnline)
    window.addEventListener('visibilitychange', onVisible)
  }
  const dispose = () => {
    // Re-check window at teardown: the bridge can outlive the page (or, in
    // tests, the stubbed global) and dispose may run after window is gone.
    if (canListen && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('visibilitychange', onVisible)
    }
    fire() // release any awaiter so the loop can observe abort and exit
  }
  if (parentSignal.aborted) dispose()
  else parentSignal.addEventListener('abort', dispose, { once: true })
  return {
    next: () => new Promise<void>((resolve) => resolvers.push(resolve)),
    dispose,
  }
}

// Sleep for `ms`, but resolve early if the wake signal fires or the loop is
// aborted — whichever comes first.
async function sleepOrWake(ms: number, wake: WakeSignal, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  let timer = 0
  let onAbort: (() => void) | null = null
  const timeout = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, ms)
  })
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([timeout, wake.next(), aborted])
  } finally {
    if (timer) window.clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

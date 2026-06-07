import { BACKEND_BASE, type BrowserNanobotToolResult, type NanobotToolCall } from './backendApi'

export interface BrowserToolBridgeContextInput {
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
  mcp_url: string
  tool_count: number
  resource_count?: number
  prompt_count?: number
  expires_at: number
}

export interface BrowserToolBridgeRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
  context_id: string
  project_id: string
  conversation_id: string
  document_id: string
  range_start: number
  range_end: number
  inputs: Record<string, unknown>
  created_at: string
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
  onActivity?: () => void
  onPollError?: (err: unknown) => void
  onRequestError?: (request: BrowserToolBridgeRequest, err: unknown) => void
  onRefreshError?: (err: unknown) => void
}

export async function startBrowserToolBridge(
  args: StartBrowserToolBridgeArgs,
): Promise<BrowserToolBridgeHandle> {
  const context = await registerBrowserToolBridgeContext({
    endpoint: args.endpoint,
    context: args.context,
  })
  args.onActivity?.()

  const ctl = new AbortController()
  const stop = () => ctl.abort('stopped')
  if (args.parentSignal.aborted) stop()
  else args.parentSignal.addEventListener('abort', stop, { once: true })

  const refreshMs = Math.max(0, args.refreshMs ?? 60000)
  const refreshTimer = refreshMs > 0
    ? window.setInterval(() => {
        if (ctl.signal.aborted) return
        registerBrowserToolBridgeContext({
          endpoint: args.endpoint,
          context: args.context,
          signal: ctl.signal,
        })
          .then(() => args.onActivity?.())
          .catch((err) => {
            if (!ctl.signal.aborted) args.onRefreshError?.(err)
          })
      }, refreshMs)
    : 0

  void runBrowserToolBridgeLoop({
    ...args,
    contextId: context.context_id,
    signal: ctl.signal,
  })

  return {
    context,
    stop: () => {
      args.parentSignal.removeEventListener('abort', stop)
      if (refreshTimer) window.clearInterval(refreshTimer)
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
  signal?: AbortSignal
  waitMs?: number
}): Promise<BrowserToolBridgeRequest[]> {
  const url = new URL(`${normalizeLocalAgentHostEndpoint(args.endpoint)}/superleaf/mcp/tool-requests`)
  url.searchParams.set('context_id', args.contextId)
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
  args: StartBrowserToolBridgeArgs & { contextId: string; signal: AbortSignal },
): Promise<void> {
  let contextId = args.contextId
  while (!args.signal.aborted) {
    let requests: BrowserToolBridgeRequest[] = []
    try {
      requests = await pollBrowserToolBridgeRequests({
        endpoint: args.endpoint,
        contextId,
        signal: args.signal,
        waitMs: args.waitMs,
      })
    } catch (err) {
      if (args.signal.aborted) break
      args.onPollError?.(err)
      try {
        const refreshed = await registerBrowserToolBridgeContext({
          endpoint: args.endpoint,
          context: args.context,
          signal: args.signal,
        })
        contextId = refreshed.context_id
        args.onActivity?.()
      } catch (refreshErr) {
        if (!args.signal.aborted) args.onRefreshError?.(refreshErr)
      }
      await sleep(800)
      continue
    }

    for (const request of requests) {
      if (args.signal.aborted) break
      await executeAndSubmitBridgeRequest(args, request)
    }
  }
}

async function executeAndSubmitBridgeRequest(
  args: StartBrowserToolBridgeArgs & { signal: AbortSignal },
  request: BrowserToolBridgeRequest,
): Promise<void> {
  try {
    const result = await args.executeRequest(request, args.signal)
    const toolKind = 'tool_kind' in result ? result.tool_kind : result.toolKind
    args.onActivity?.()
    await submitBrowserToolBridgeResult({
      endpoint: args.endpoint,
      requestId: request.id,
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
    args.onRequestError?.(request, err)
    await submitBrowserToolBridgeResult({
      endpoint: args.endpoint,
      requestId: request.id,
      content: err instanceof Error ? err.message : String(err),
      failed: true,
      name: request.name,
      toolKind: 'superleaf_mcp',
      events: [],
      signal: args.signal,
    }).catch(() => undefined)
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

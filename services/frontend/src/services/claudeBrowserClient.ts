import type { BrowserClaudePrepare, ProviderModel } from './backendApi'
import { localAgentHostAuthHeaders, normalizeLocalAgentHostEndpoint } from './browserToolBridge'

export interface BrowserClaudeHealth {
  status: string
  service?: string
  claude_enabled?: boolean
  claude_bin?: string
  claude_version?: string
  error?: string
  superleaf_mcp_url?: string
  superleaf_mcp_tool_count?: number
  [key: string]: unknown
}

export interface BrowserClaudeSession {
  id: string
  kind: string
  superleaf_project_id?: string
  superleaf_conversation_id?: string
  workspace_path?: string
  claude_session_id?: string
  turn_count?: number
  [key: string]: unknown
}

export interface BrowserClaudeTurnResult {
  session: BrowserClaudeSession
  output: string
  error: string
  claudeSessionId: string
  events: unknown[]
}

export interface BrowserClaudeSessionList {
  status: string
  kind: string
  count: number
  sessions: BrowserClaudeSession[]
  filters?: Record<string, unknown>
  [key: string]: unknown
}

export async function probeBrowserClaude(endpoint: string): Promise<BrowserClaudeHealth> {
  const normalizedEndpoint = normalizeClaudeEndpoint(endpoint)
  const resp = await fetch(`${normalizedEndpoint}/claude/health`, {
    method: 'GET',
    headers: localAgentHostAuthHeaders(normalizedEndpoint),
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`Claude health ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  if (String(payload.status || '') !== 'ok') {
    throw new Error(String(payload.error || payload.status || 'Claude is not ready'))
  }
  return payload as BrowserClaudeHealth
}

export function listBrowserClaudeModels(_endpoint: string): ProviderModel[] {
  return [
    {
      id: 'claude',
      name: 'Claude Code',
      description: 'Local Claude Code CLI via SuperLeaf Local Agent Host.',
    },
  ]
}

export async function createBrowserClaudeSession(args: {
  endpoint: string
  prepared: BrowserClaudePrepare
  providerName: string
  superleafOrigin?: string
}): Promise<BrowserClaudeSession> {
  const workspacePath = args.prepared.workspace_path.trim()
  if (!workspacePath) {
    throw new Error('Claude Local 缺少 workspace path，请编辑 Provider 设置代码项目路径')
  }
  const normalizedEndpoint = normalizeClaudeEndpoint(args.endpoint)
  const resp = await fetch(`${normalizedEndpoint}/claude/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...localAgentHostAuthHeaders(normalizedEndpoint),
    },
    body: JSON.stringify({
      superleaf_origin: args.superleafOrigin ?? window.location.origin,
      superleaf_project_id: String(args.prepared.superleaf_context.project_id ?? ''),
      superleaf_conversation_id: String(args.prepared.superleaf_context.conversation_id ?? ''),
      workspace_path: workspacePath,
      model: claudeModel(args.prepared),
      metadata: {
        provider_id: args.prepared.provider_id,
        provider_name: args.providerName,
        document_id: args.prepared.document_id,
      },
    }),
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`Claude session ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  return payload as BrowserClaudeSession
}

export async function listBrowserClaudeSessions(
  endpoint: string,
  query: {
    superleafConversationId?: string
    superleafProjectId?: string
    workspacePath?: string
    limit?: number
  } = {},
): Promise<BrowserClaudeSessionList> {
  const params = new URLSearchParams()
  if (query.superleafConversationId) {
    params.set('superleaf_conversation_id', query.superleafConversationId)
  }
  if (query.superleafProjectId) {
    params.set('superleaf_project_id', query.superleafProjectId)
  }
  if (query.workspacePath) {
    params.set('workspace_path', query.workspacePath)
  }
  if (query.limit) {
    params.set('limit', String(query.limit))
  }
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const normalizedEndpoint = normalizeClaudeEndpoint(endpoint)
  const resp = await fetch(`${normalizedEndpoint}/claude/sessions${suffix}`, {
    method: 'GET',
    headers: localAgentHostAuthHeaders(normalizedEndpoint),
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`Claude sessions ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  return payload as unknown as BrowserClaudeSessionList
}

export async function runBrowserClaudeTurn(args: {
  endpoint: string
  sessionId: string
  prepared: BrowserClaudePrepare
  signal?: AbortSignal
  onActivity?: () => void
  onDelta?: (delta: string) => void
}): Promise<BrowserClaudeTurnResult> {
  const normalizedEndpoint = normalizeClaudeEndpoint(args.endpoint)
  const resp = await fetch(`${normalizedEndpoint}/claude/sessions/${encodeURIComponent(args.sessionId)}/turns`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...localAgentHostAuthHeaders(normalizedEndpoint),
    },
    body: JSON.stringify({
      stream: true,
      prompt: buildClaudePrompt(args.prepared),
      superleaf_context: args.prepared.superleaf_context,
      model: claudeModel(args.prepared),
    }),
    signal: args.signal,
  })
  args.onActivity?.()
  const payload = resp.headers.get('content-type')?.includes('text/event-stream')
    ? await readClaudeSse(resp, args.onDelta, args.onActivity)
    : await readJson(resp)
  if (!resp.ok) {
    throw new Error(`Claude turn ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  const output = typeof payload.output === 'string' ? payload.output : ''
  const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : 0
  const explicitError = stringError(payload)
  const error = exitCode === 0 && !explicitError
    ? ''
    : explicitError || (typeof payload.stderr === 'string' ? payload.stderr : '')
  return {
    session: payload.session as BrowserClaudeSession,
    output,
    error,
    claudeSessionId: typeof payload.claude_session_id === 'string' ? payload.claude_session_id : '',
    events: Array.isArray(payload.events) ? payload.events : [],
  }
}

export function normalizeClaudeEndpoint(endpoint: string): string {
  return normalizeLocalAgentHostEndpoint(endpoint)
}

async function readClaudeSse(
  resp: Response,
  onDelta?: (delta: string) => void,
  onActivity?: () => void,
): Promise<Record<string, unknown>> {
  if (!resp.body) return {}
  const decoder = new TextDecoder('utf-8')
  const reader = resp.body.getReader()
  let buffer = ''
  const outputParts: string[] = []
  let donePayload: Record<string, unknown> = {}
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    onActivity?.()
    buffer += decoder.decode(value, { stream: true })
    let boundary = findEventBoundary(buffer)
    while (boundary !== null) {
      const raw = buffer.slice(0, boundary.start)
      buffer = buffer.slice(boundary.end)
      const evt = parseSseEvent(raw)
      if (evt?.event === 'delta') {
        const delta = String((evt.data as { delta?: unknown }).delta ?? '')
        if (delta) {
          outputParts.push(delta)
          onDelta?.(delta)
        }
      } else if (evt?.event === 'done') {
        donePayload = evt.data && typeof evt.data === 'object'
          ? evt.data as Record<string, unknown>
          : {}
      } else if (evt?.event === 'error') {
        donePayload = evt.data && typeof evt.data === 'object'
          ? evt.data as Record<string, unknown>
          : { message: String(evt.data ?? '') }
      }
      boundary = findEventBoundary(buffer)
    }
  }
  if (outputParts.length > 0 && typeof donePayload.output !== 'string') {
    donePayload.output = outputParts.join('')
  }
  return donePayload
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

function buildClaudePrompt(prepared: BrowserClaudePrepare): string {
  return [
    prepared.system_prompt ? `[SYSTEM]\n${prepared.system_prompt}` : '',
    prepared.prompt,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function claudeModel(prepared: BrowserClaudePrepare): string {
  return String(prepared.claude_settings?.model || prepared.model || '').trim()
}

function stringError(payload: Record<string, unknown>): string {
  return String(payload.message || payload.error || payload.text || '')
}

function findEventBoundary(buf: string): { start: number; end: number } | null {
  const crlf = buf.indexOf('\r\n\r\n')
  const lf = buf.indexOf('\n\n')
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { start: crlf, end: crlf + 4 }
  if (lf !== -1) return { start: lf, end: lf + 2 }
  return null
}

function parseSseEvent(raw: string): { event: string; data: unknown } | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  const dataRaw = dataLines.join('\n')
  try {
    return { event, data: JSON.parse(dataRaw) as unknown }
  } catch {
    return { event, data: dataRaw }
  }
}

import type {
  NanobotChatMessage,
  NanobotToolCall,
  NanobotToolDefinition,
  ProviderModel,
} from './backendApi'
import { formatSuperleafToolDefinitions } from './superleafTools'

const BROWSER_NANOBOT_KEY_PREFIX = 'superleaf.nanobotBrowser.apiKey.'
const DEFAULT_NANOBOT_AGENT_ID = 'nanobot-agent'
export const DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT = 'http://127.0.0.1:8787'

export interface BrowserNanobotTurnResult {
  content: string
  toolCalls: NanobotToolCall[]
}

export interface BrowserNanobotTurnArgs {
  endpoint: string
  apiKey?: string
  model: string
  sessionId?: string
  messages: NanobotChatMessage[]
  tools?: NanobotToolDefinition[]
  signal?: AbortSignal
  onDelta?: (delta: string) => void
  onActivity?: () => void
}

export interface BrowserNanobotToolAdapter {
  mode?: string
  transport?: string
  tool_count?: number
  tool_names?: string[]
  instructions?: string
  [key: string]: unknown
}

export interface BrowserNanobotToolDiagnostics {
  status?: string
  kind?: string
  adapter?: BrowserNanobotToolAdapter
  tools?: NanobotToolDefinition[]
  adapter_endpoint?: string
  adapter_source?: 'configured-endpoint' | 'default-local-agent-host'
  superleaf_mcp_url?: string
  superleaf_mcp_tool_count?: number
  mcp_contexts?: number
  mcp_pending_calls?: number
  [key: string]: unknown
}

export function storeBrowserNanobotApiKey(providerId: string, apiKey: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(`${BROWSER_NANOBOT_KEY_PREFIX}${providerId}`, apiKey)
}

export function readBrowserNanobotApiKey(providerId: string): string {
  if (typeof localStorage === 'undefined') return 'dummy'
  return localStorage.getItem(`${BROWSER_NANOBOT_KEY_PREFIX}${providerId}`) || 'dummy'
}

export async function probeBrowserNanobot(endpoint: string, apiKey = 'dummy'): Promise<unknown> {
  const resp = await fetch(`${normalizeNanobotEndpoint(endpoint)}/health`, {
    method: 'GET',
    headers: authHeaders(apiKey),
  })
  if (!resp.ok && resp.status !== 404 && resp.status !== 405) {
    throw new Error(`Nanobot health ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`)
  }
  if (!resp.headers.get('content-type')?.toLowerCase().includes('json')) return {}
  return resp.json().catch(() => ({}))
}

export async function discoverBrowserNanobotAgents(endpoint: string, apiKey = 'dummy'): Promise<ProviderModel[]> {
  let health: unknown = null
  let healthError: unknown = null
  try {
    health = await probeBrowserNanobot(endpoint, apiKey)
  } catch (err) {
    healthError = err
  }
  const toolDiagnostics = await probeBrowserNanobotTools(endpoint, apiKey).catch(() => null)
  if (!health && toolDiagnostics?.adapter_endpoint) {
    health = await probeBrowserNanobot(toolDiagnostics.adapter_endpoint, apiKey).catch(() => null)
  }
  if (!health && healthError) throw healthError
  const toolCount = toolDiagnostics?.adapter?.tool_count ?? toolDiagnostics?.superleaf_mcp_tool_count ?? 0
  const name = health && typeof health === 'object'
    ? String((health as Record<string, unknown>).name ?? (health as Record<string, unknown>).service ?? 'Nanobot')
    : 'Nanobot'
  const adapterEndpoint = toolDiagnostics?.adapter_endpoint ?? ''
  return [
    {
      id: DEFAULT_NANOBOT_AGENT_ID,
      name,
      description: toolCount > 0
        ? `Integrated local Nanobot Agent with ${toolCount} SuperLeaf tools.`
        : 'Integrated local Nanobot Agent.',
      raw: {
        id: DEFAULT_NANOBOT_AGENT_ID,
        source: toolDiagnostics ? 'local-host-tool-adapter' : 'health',
        health,
        tool_adapter: toolDiagnostics,
        superleaf_tool_count: toolCount,
        superleaf_tool_names: toolDiagnostics?.adapter?.tool_names ?? [],
        local_agent_host_endpoint: adapterEndpoint,
        nanobot_adapter_endpoint: adapterEndpoint,
        nanobot_adapter_source: toolDiagnostics?.adapter_source ?? '',
        nanobot_adapter_mode: toolDiagnostics?.adapter?.mode ?? '',
      },
    },
  ]
}

export async function probeBrowserNanobotTools(
  endpoint: string,
  apiKey = 'dummy',
): Promise<BrowserNanobotToolDiagnostics | null> {
  const candidates = uniqueEndpoints([
    endpoint,
    DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT,
  ])
  let lastError: unknown = null
  for (const candidate of candidates) {
    try {
      const diagnostics = await probeBrowserNanobotToolsAtEndpoint(
        candidate,
        apiKey,
        candidate === normalizeNanobotEndpoint(endpoint) ? 'configured-endpoint' : 'default-local-agent-host',
      )
      if (diagnostics) return diagnostics
    } catch (err) {
      lastError = err
    }
  }
  if (lastError) throw lastError
  return null
}

export async function streamBrowserNanobotTurn(args: BrowserNanobotTurnArgs): Promise<BrowserNanobotTurnResult> {
  const body: Record<string, unknown> = {
    messages: compactNanobotMessages(args.messages, args.tools),
    stream: false,
    temperature: 0.2,
    max_tokens: 4000,
  }
  if (args.model && args.model !== DEFAULT_NANOBOT_AGENT_ID) {
    body.model = args.model
  }
  if (args.sessionId) {
    body.session_id = args.sessionId
  }
  if (args.tools && args.tools.length > 0) {
    body.tools = args.tools
    body.tool_choice = 'auto'
  }

  const resp = await fetch(`${normalizeNanobotEndpoint(args.endpoint)}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders(args.apiKey || 'dummy'),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
    signal: args.signal,
  })
  if (!resp.ok || !resp.body) {
    throw new Error(`Nanobot chat ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`)
  }
  if (!resp.headers.get('content-type')?.toLowerCase().includes('event-stream')) {
    const result = extractCompletionResult(await readResponsePayload(resp))
    if (result.content) args.onDelta?.(result.content)
    args.onActivity?.()
    return result
  }

  const decoder = new TextDecoder('utf-8')
  const reader = resp.body.getReader()
  const contentParts: string[] = []
  const toolAccumulator = new ToolCallAccumulator()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    args.onActivity?.()
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/u)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const payload = parseDataLine(line)
      if (!payload) continue
      if (payload === '[DONE]') {
        return { content: contentParts.join(''), toolCalls: toolAccumulator.calls() }
      }
      let evt: unknown
      try {
        evt = JSON.parse(payload)
      } catch {
        continue
      }
      const delta = extractDelta(evt)
      if (delta.content) {
        contentParts.push(delta.content)
        args.onDelta?.(delta.content)
      }
      if (delta.toolCalls.length > 0) {
        toolAccumulator.add(delta.toolCalls)
      }
    }
  }

  return { content: contentParts.join(''), toolCalls: toolAccumulator.calls() }
}

function compactNanobotMessages(
  messages: NanobotChatMessage[],
  tools: NanobotToolDefinition[] = [],
): NanobotChatMessage[] {
  const system = messages
    .filter((message) => message.role === 'system' && message.content)
    .map((message) => String(message.content))
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const toolNames = toolCallNameMap(messages)
  const toolResults = messages.filter((message) => message.role === 'tool')
  const sections: string[] = []
  if (system.length > 0) {
    sections.push(`[SUPERLEAF INSTRUCTIONS]\n${system.join('\n\n')}`)
  }
  if (tools.length > 0) {
    sections.push(`[AVAILABLE SUPERLEAF TOOLS]\n${formatSuperleafToolDefinitions(tools)}`)
  }
  if (lastUser?.content) {
    sections.push(`[CURRENT USER MESSAGE]\n${lastUser.content}`)
  }
  if (toolResults.length > 0) {
    sections.push(`[SUPERLEAF TOOL RESULTS]\n${formatToolResults(toolResults, toolNames)}`)
    sections.push(
      [
        'Use the tool results above to answer the user.',
        'If more SuperLeaf project context is needed, call additional available tools as needed.',
        'Do not repeat a tool call whose result is already shown unless the user asks or the result is insufficient.',
      ].join(' '),
    )
  }
  if (sections.length > 0) return [{ role: 'user', content: sections.join('\n\n') }]
  const last = messages[messages.length - 1]
  if (!last) return []
  return [{ role: 'user', content: last.content ?? '' }]
}

function toolCallNameMap(messages: NanobotChatMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (!Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      if (call.id) names.set(call.id, call.function?.name || 'tool')
    }
  }
  return names
}

function formatToolResults(messages: NanobotChatMessage[], names: Map<string, string>): string {
  return messages
    .map((message, idx) => {
      const callId = message.tool_call_id || `tool-${idx + 1}`
      const name = names.get(callId) || 'tool'
      return [
        `Tool result ${idx + 1}: ${name}`,
        `tool_call_id: ${callId}`,
        'content:',
        message.content ?? '',
      ].join('\n')
    })
    .join('\n\n')
}

export function normalizeNanobotEndpoint(endpoint: string): string {
  let cleaned = endpoint.trim().replace(/\s+/gu, '').replace(/\/+$/u, '')
  if (cleaned.endsWith('/v1')) cleaned = cleaned.slice(0, -3).replace(/\/+$/u, '')
  return cleaned
}

export function nanobotLocalAgentHostEndpointFromRaw(raw: Record<string, unknown> | undefined): string {
  if (!raw) return ''
  for (const key of ['local_agent_host_endpoint', 'nanobot_adapter_endpoint', 'adapter_endpoint']) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return normalizeNanobotEndpoint(value)
  }
  const toolAdapter = raw.tool_adapter
  if (toolAdapter && typeof toolAdapter === 'object') {
    const value = (toolAdapter as Record<string, unknown>).adapter_endpoint
    if (typeof value === 'string' && value.trim()) return normalizeNanobotEndpoint(value)
  }
  return ''
}

async function probeBrowserNanobotToolsAtEndpoint(
  endpoint: string,
  apiKey: string,
  source: BrowserNanobotToolDiagnostics['adapter_source'],
): Promise<BrowserNanobotToolDiagnostics | null> {
  const normalized = normalizeNanobotEndpoint(endpoint)
  const resp = await fetch(`${normalized}/nanobot/tools`, {
    method: 'GET',
    headers: authHeaders(apiKey),
  })
  if (resp.status === 404 || resp.status === 405) return null
  if (!resp.ok) {
    throw new Error(`Nanobot tool adapter ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`)
  }
  if (!resp.headers.get('content-type')?.toLowerCase().includes('json')) return null
  const payload = await resp.json().catch(() => null)
  return payload && typeof payload === 'object'
    ? {
        ...(payload as BrowserNanobotToolDiagnostics),
        adapter_endpoint: normalized,
        adapter_source: source,
      }
    : null
}

function uniqueEndpoints(values: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = normalizeNanobotEndpoint(value || DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function authHeaders(apiKey: string): Record<string, string> {
  const token = apiKey.trim()
  if (!token || token === 'dummy') return {}
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function readResponsePayload(resp: Response): Promise<unknown> {
  const text = await resp.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function parseDataLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('data:')) return null
  return trimmed.slice(5).trim()
}

interface DeltaResult {
  content: string
  toolCalls: StreamingToolCallDelta[]
}

interface StreamingToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

function extractDelta(evt: unknown): DeltaResult {
  if (!evt || typeof evt !== 'object') return { content: '', toolCalls: [] }
  const choices = (evt as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return { content: '', toolCalls: [] }
  const first = choices[0]
  if (!first || typeof first !== 'object') return { content: '', toolCalls: [] }
  const delta = (first as { delta?: unknown; message?: unknown; text?: unknown }).delta
  if (delta && typeof delta === 'object') {
    const raw = delta as { content?: unknown; tool_calls?: unknown }
    return {
      content: typeof raw.content === 'string' ? raw.content : '',
      toolCalls: Array.isArray(raw.tool_calls)
        ? raw.tool_calls.map((item, idx) => normalizeToolDelta(item, idx)).filter(isToolDelta)
        : [],
    }
  }
  const message = (first as { message?: unknown }).message
  if (message && typeof message === 'object') {
    const raw = message as { content?: unknown; tool_calls?: unknown }
    return {
      content: typeof raw.content === 'string' ? raw.content : '',
      toolCalls: Array.isArray(raw.tool_calls)
        ? raw.tool_calls.map((item, idx) => normalizeToolDelta(item, idx)).filter(isToolDelta)
        : [],
    }
  }
  const text = (first as { text?: unknown }).text
  return { content: typeof text === 'string' ? text : '', toolCalls: [] }
}

function extractCompletionResult(evt: unknown): BrowserNanobotTurnResult {
  const delta = extractDelta(evt)
  if (delta.content || delta.toolCalls.length > 0) {
    const toolAccumulator = new ToolCallAccumulator()
    toolAccumulator.add(delta.toolCalls)
    const nativeCalls = toolAccumulator.calls()
    const textCalls = nativeCalls.length === 0 ? extractTextToolCalls(delta.content) : []
    return {
      content: textCalls.length > 0 ? '' : delta.content,
      toolCalls: nativeCalls.length > 0 ? nativeCalls : textCalls,
    }
  }
  if (typeof evt === 'string') {
    const calls = extractTextToolCalls(evt)
    return { content: calls.length > 0 ? '' : evt, toolCalls: calls }
  }
  if (!evt || typeof evt !== 'object') {
    return { content: '', toolCalls: [] }
  }
  const raw = evt as Record<string, unknown>
  for (const key of ['content', 'answer', 'response', 'output', 'text']) {
    const value = raw[key]
    if (typeof value === 'string') {
      const calls = extractTextToolCalls(value)
      return { content: calls.length > 0 ? '' : value, toolCalls: calls }
    }
  }
  const message = raw.message
  if (typeof message === 'string') {
    const calls = extractTextToolCalls(message)
    return { content: calls.length > 0 ? '' : message, toolCalls: calls }
  }
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') {
      const calls = extractTextToolCalls(content)
      return { content: calls.length > 0 ? '' : content, toolCalls: calls }
    }
  }
  return { content: '', toolCalls: [] }
}

function extractTextToolCalls(content: string): NanobotToolCall[] {
  const pattern = /<superleaf_tool_call>\s*([\s\S]*?)\s*<\/superleaf_tool_call>/giu
  const calls: NanobotToolCall[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const parsed = parseTextToolCall(match[1])
    if (parsed) calls.push(parsed)
  }
  return calls
}

function parseTextToolCall(rawJson: string): NanobotToolCall | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) return null
  const args = raw.arguments && typeof raw.arguments === 'object'
    ? raw.arguments
    : {}
  return {
    id: `text_tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

function normalizeToolDelta(item: unknown, fallbackIndex: number): StreamingToolCallDelta | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as Record<string, unknown>
  const fn = raw.function && typeof raw.function === 'object'
    ? raw.function as Record<string, unknown>
    : undefined
  return {
    index: typeof raw.index === 'number' ? raw.index : fallbackIndex,
    id: typeof raw.id === 'string' ? raw.id : undefined,
    type: typeof raw.type === 'string' ? raw.type : undefined,
    function: fn
      ? {
          name: typeof fn.name === 'string' ? fn.name : undefined,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : undefined,
        }
      : undefined,
  }
}

function isToolDelta(item: StreamingToolCallDelta | null): item is StreamingToolCallDelta {
  return item !== null
}

class ToolCallAccumulator {
  private readonly byIndex = new Map<number, NanobotToolCall>()

  add(deltas: StreamingToolCallDelta[]): void {
    for (const delta of deltas) {
      const existing = this.byIndex.get(delta.index) ?? {
        id: delta.id || `tool_${delta.index}`,
        type: 'function' as const,
        function: { name: '', arguments: '' },
      }
      if (delta.id) existing.id = delta.id
      if (delta.function?.name) existing.function.name += delta.function.name
      if (delta.function?.arguments) existing.function.arguments += delta.function.arguments
      this.byIndex.set(delta.index, existing)
    }
  }

  calls(): NanobotToolCall[] {
    return Array.from(this.byIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call)
      .filter((call) => call.function.name.trim())
  }
}

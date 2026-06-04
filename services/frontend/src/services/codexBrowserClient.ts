import type {
  BrowserCodexPrepare,
  BrowserNanobotToolResult,
  NanobotToolCall,
  NanobotToolDefinition,
  ProviderDraft,
  ProviderModel,
} from './backendApi'

export interface BrowserCodexHealth {
  status: string
  service?: string
  codex_enabled?: boolean
  codex_bin?: string
  codex_version?: string
  error?: string
  data_dir?: string
  [key: string]: unknown
}

export interface BrowserCodexSession {
  id: string
  kind: string
  superleaf_project_id?: string
  superleaf_conversation_id?: string
  workspace_path?: string
  codex_session_id?: string
  turn_count?: number
  [key: string]: unknown
}

export interface BrowserCodexTurnResult {
  session: BrowserCodexSession
  output: string
  error: string
  codexSessionId: string
  events: unknown[]
  toolCalls: NanobotToolCall[]
}

const SUPERLEAF_TOOL_MARKER = '<superleaf_tool_call'

export async function probeBrowserCodex(endpoint: string): Promise<BrowserCodexHealth> {
  const resp = await fetch(`${normalizeCodexEndpoint(endpoint)}/codex/health`, {
    method: 'GET',
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`Codex health ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  if (String(payload.status || '') !== 'ok') {
    throw new Error(String(payload.error || payload.status || 'Codex is not ready'))
  }
  return payload as BrowserCodexHealth
}

export async function listBrowserCodexModels(endpoint: string): Promise<ProviderModel[]> {
  const resp = await fetch(`${normalizeCodexEndpoint(endpoint)}/codex/models?limit=100`, {
    method: 'GET',
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`Codex models ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  const models = Array.isArray(payload.models) ? payload.models : []
  return models.map(normalizeBrowserCodexModel).filter((model) => model.id && model.id !== 'codex')
}

export async function createBrowserCodexSession(args: {
  endpoint: string
  prepared: BrowserCodexPrepare
  providerName: string
  superleafOrigin?: string
}): Promise<BrowserCodexSession> {
  const workspacePath = args.prepared.workspace_path.trim()
  if (!workspacePath) {
    throw new Error('Codex Agent 缺少 workspace path，请编辑 Provider 设置代码项目路径')
  }
  const resp = await fetch(`${normalizeCodexEndpoint(args.endpoint)}/codex/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      superleaf_origin: args.superleafOrigin ?? window.location.origin,
      superleaf_project_id: String(args.prepared.superleaf_context.project_id ?? ''),
      superleaf_conversation_id: String(args.prepared.superleaf_context.conversation_id ?? ''),
      workspace_path: workspacePath,
      model: codexModel(args.prepared),
      service_tier: codexServiceTier(args.prepared),
      effort: codexEffort(args.prepared),
      summary: codexSummary(args.prepared),
      sandbox: codexSandbox(args.prepared),
      approval_policy: codexApprovalPolicy(args.prepared),
      metadata: {
        provider_id: args.prepared.provider_id,
        provider_name: args.providerName,
        document_id: args.prepared.document_id,
      },
    }),
  })
  const payload = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`Codex session ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  return payload as BrowserCodexSession
}

export async function runBrowserCodexTurn(args: {
  endpoint: string
  sessionId: string
  prepared: BrowserCodexPrepare
  toolResults?: BrowserNanobotToolResult[]
  signal?: AbortSignal
  onActivity?: () => void
  onDelta?: (delta: string) => void
}): Promise<BrowserCodexTurnResult> {
  const resp = await fetch(`${normalizeCodexEndpoint(args.endpoint)}/codex/sessions/${encodeURIComponent(args.sessionId)}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stream: true,
      prompt: buildCodexPrompt(args.prepared, args.toolResults ?? []),
      superleaf_context: args.prepared.superleaf_context,
      model: codexModel(args.prepared),
      service_tier: codexServiceTier(args.prepared),
      effort: codexEffort(args.prepared),
      summary: codexSummary(args.prepared),
      sandbox: codexSandbox(args.prepared),
      approval_policy: codexApprovalPolicy(args.prepared),
    }),
    signal: args.signal,
  })
  args.onActivity?.()
  const payload = resp.headers.get('content-type')?.includes('text/event-stream')
    ? await readCodexSse(resp, args.onDelta, args.onActivity)
    : await readJson(resp)
  if (!resp.ok) {
    throw new Error(`Codex turn ${resp.status}: ${stringError(payload) || resp.statusText}`)
  }
  const rawOutput = typeof payload.output === 'string' ? payload.output : ''
  const toolCalls = extractCodexToolCalls(rawOutput)
  const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : 0
  const explicitError = stringError(payload)
  const error = exitCode === 0 && !explicitError
    ? ''
    : explicitError || (typeof payload.stderr === 'string' ? payload.stderr : '')
  return {
    session: payload.session as BrowserCodexSession,
    output: toolCalls.length > 0 ? '' : stripCodexToolCalls(rawOutput),
    error,
    codexSessionId: typeof payload.codex_session_id === 'string' ? payload.codex_session_id : '',
    events: Array.isArray(payload.events) ? payload.events : [],
    toolCalls,
  }
}

export function normalizeCodexEndpoint(endpoint: string): string {
  const cleaned = endpoint.trim().replace(/\s+/gu, '').replace(/\/+$/u, '')
  return cleaned || 'http://127.0.0.1:8787'
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

async function readCodexSse(
  resp: Response,
  onDelta?: (delta: string) => void,
  onActivity?: () => void,
): Promise<Record<string, unknown>> {
  if (!resp.body) return {}
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = 'message'
  let dataLines: string[] = []
  let donePayload: Record<string, unknown> | null = null
  let errorPayload: Record<string, unknown> | null = null
  let rawOutput = ''
  let suppressToolMarkerOutput = false

  const dispatch = () => {
    if (dataLines.length === 0) {
      currentEvent = 'message'
      return
    }
    const dataText = dataLines.join('\n')
    dataLines = []
    let data: Record<string, unknown> = {}
    try {
      data = JSON.parse(dataText) as Record<string, unknown>
    } catch {
      data = { text: dataText }
    }
    onActivity?.()
    if (currentEvent === 'delta') {
      const delta = stringValue(data.delta)
      rawOutput += delta
      const trimmed = rawOutput.trimStart()
      if (
        '<superleaf_tool_call>'.startsWith(trimmed) ||
        trimmed.startsWith(SUPERLEAF_TOOL_MARKER) ||
        rawOutput.includes(SUPERLEAF_TOOL_MARKER)
      ) {
        suppressToolMarkerOutput = true
      }
      if (!suppressToolMarkerOutput && delta) onDelta?.(delta)
    } else if (currentEvent === 'done') {
      donePayload = data
    } else if (currentEvent === 'error') {
      errorPayload = data
    }
    currentEvent = 'message'
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/u)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line === '') {
        dispatch()
      } else if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim() || 'message'
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/u)) {
      if (line.startsWith('event:')) currentEvent = line.slice(6).trim() || 'message'
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
  }
  dispatch()
  return donePayload ?? errorPayload ?? {}
}

function stringError(payload: Record<string, unknown>): string {
  return String(payload.message || payload.error || payload.text || '')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeBrowserCodexModel(value: unknown): ProviderModel {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const model = stringValue(raw.model) || stringValue(raw.id)
  const id = model || stringValue(raw.id)
  const name = stringValue(raw.name) || stringValue(raw.displayName) || model || id
  return {
    id,
    model,
    name,
    description: stringValue(raw.description),
    hidden: Boolean(raw.hidden),
    is_default: Boolean(raw.is_default || raw.isDefault),
    default_reasoning_effort: stringValue(raw.default_reasoning_effort || raw.defaultReasoningEffort),
    supported_reasoning_efforts: Array.isArray(raw.supported_reasoning_efforts)
      ? raw.supported_reasoning_efforts.map(normalizeBrowserCodexReasoningEffort).filter(Boolean)
      : [],
    service_tiers: normalizeBrowserCodexServiceTiers(raw.service_tiers || raw.serviceTiers),
    default_service_tier: stringValue(raw.default_service_tier || raw.defaultServiceTier),
    raw: raw.raw && typeof raw.raw === 'object' ? raw.raw as Record<string, unknown> : raw,
  }
}

function normalizeBrowserCodexReasoningEffort(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return stringValue(raw.reasoningEffort || raw.id || raw.name)
}

function normalizeBrowserCodexServiceTiers(value: unknown): Array<{ id: string; name: string; description?: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') {
        const id = item.trim()
        return { id, name: id }
      }
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const id = stringValue(raw.id) || stringValue(raw.name)
      return {
        id,
        name: stringValue(raw.name) || id,
        description: stringValue(raw.description),
      }
    })
    .filter((item) => item.id)
}

function buildCodexPrompt(
  prepared: BrowserCodexPrepare,
  toolResults: BrowserNanobotToolResult[],
): string {
  if (prepared.prompt_mode !== 'full-agent') {
    return buildFastCodexPrompt(prepared, toolResults)
  }
  const sections: string[] = []
  if (prepared.system_prompt.trim()) {
    sections.push(`[SUPERLEAF INSTRUCTIONS]\n${prepared.system_prompt.trim()}`)
  }
  if (prepared.tools.length > 0) {
    sections.push(`[AVAILABLE SUPERLEAF TOOLS]\n${formatToolDefinitions(prepared.tools)}`)
  }
  if (toolResults.length > 0) {
    sections.push(`[SUPERLEAF TOOL RESULTS]\n${formatToolResults(toolResults)}`)
    sections.push(
      [
        'Use the tool results above to answer the user.',
        'If more SuperLeaf project context is needed, request additional SuperLeaf tool call markers as needed.',
        'Do not repeat a tool call whose result is already shown unless the user asks or the result is insufficient.',
      ].join(' '),
    )
  }
  sections.push(`[CURRENT USER MESSAGE]\n${prepared.prompt}`)
  return sections.join('\n\n')
}

function buildFastCodexPrompt(
  prepared: BrowserCodexPrepare,
  toolResults: BrowserNanobotToolResult[],
): string {
  const sections: string[] = [
    [
      '[SUPERLEAF FAST MODE]',
      'You are local Codex inside the SuperLeaf editor.',
      'Stay concise. Preserve SuperLeaf as the editing and collaboration UI.',
      'For selected-text rewrites, request propose_doc_edit instead of telling the user to edit manually.',
      'Do not claim edits are applied; SuperLeaf shows proposal cards for user approval.',
      '[END SUPERLEAF FAST MODE]',
    ].join('\n'),
  ]
  if (prepared.tools.length > 0) {
    sections.push(`[SUPERLEAF TOOL GUIDE]\n${formatCompactToolGuide(prepared.tools)}`)
  }
  if (toolResults.length > 0) {
    sections.push(`[SUPERLEAF TOOL RESULTS]\n${formatToolResults(toolResults)}`)
    sections.push('Use the tool results above. If more project reads are necessary, request additional tool markers as needed.')
  }
  sections.push(prepared.prompt)
  return sections.join('\n\n')
}

function formatToolDefinitions(tools: NanobotToolDefinition[]): string {
  const rendered = tools.map((tool) => {
    const fn = tool.function
    return [
      `- ${fn.name}`,
      fn.description ? `  description: ${fn.description}` : '',
      `  arguments_schema: ${JSON.stringify(fn.parameters ?? { type: 'object', properties: {} })}`,
    ].filter(Boolean).join('\n')
  })
  return [
    'These tools are executed by SuperLeaf backend authorization, not by your local shell.',
    'Never say these tools are not mounted or unavailable.',
    'Do not use your own local filesystem as a substitute for SuperLeaf project/document tools.',
    'To request one tool, reply with exactly one marker and no prose. Use standard ASCII JSON double quotes and include the closing tag:',
    '<superleaf_tool_call>{"name":"project_list_docs","arguments":{}}</superleaf_tool_call>',
    'Available schemas:',
    ...rendered,
  ].join('\n')
}

function formatCompactToolGuide(tools: NanobotToolDefinition[]): string {
  const rendered = tools.map((tool) => {
    const fn = tool.function
    const params = fn.parameters ?? {}
    const required = Array.isArray(params.required) ? params.required.map(String) : []
    const props = params.properties && typeof params.properties === 'object'
      ? Object.keys(params.properties)
      : []
    const args = required.length > 0
      ? `required: ${required.join(', ')}`
      : props.length > 0
        ? `args: ${props.join(', ')}`
        : 'args: none'
    return `- ${fn.name} (${args})`
  })
  return [
    'Tools are executed by SuperLeaf backend authorization, not by local shell.',
    'To request exactly one tool, reply only with standard ASCII JSON double quotes and the closing tag:',
    '<superleaf_tool_call>{"name":"project_read_doc","arguments":{"doc_id":"..."}}</superleaf_tool_call>',
    'Use propose_doc_edit for document changes; it creates an approval proposal, not an applied edit.',
    ...rendered,
  ].join('\n')
}

function formatToolResults(results: BrowserNanobotToolResult[]): string {
  return results
    .map((result, idx) => [
      `Tool result ${idx + 1}: ${result.name || 'tool'}`,
      `tool_call_id: ${result.tool_call_id}`,
      `failed: ${result.failed ? 'true' : 'false'}`,
      'content:',
      result.content ?? '',
    ].join('\n'))
    .join('\n\n')
}

export function extractCodexToolCalls(content: string): NanobotToolCall[] {
  const calls: NanobotToolCall[] = []
  for (const raw of extractTextToolCallPayloads(content)) {
    const parsed = parseTextToolCall(raw)
    if (parsed) calls.push(parsed)
  }
  return calls
}

function stripCodexToolCalls(content: string): string {
  const marker = content.toLowerCase().indexOf(SUPERLEAF_TOOL_MARKER)
  if (marker === -1) return content.trim()
  const closePattern = /<\/superleaf_tool_call>/iu
  const afterMarker = content.slice(marker)
  const close = afterMarker.search(closePattern)
  if (close === -1) return content.slice(0, marker).trim()
  return `${content.slice(0, marker)}${afterMarker.slice(close).replace(closePattern, '')}`.trim()
}

function extractTextToolCallPayloads(content: string): string[] {
  const payloads: string[] = []
  let cursor = 0
  while (cursor < content.length) {
    const lower = content.toLowerCase()
    const marker = lower.indexOf(SUPERLEAF_TOOL_MARKER, cursor)
    if (marker === -1) break
    const tagEnd = content.indexOf('>', marker)
    const bodyStart = tagEnd === -1 ? marker + SUPERLEAF_TOOL_MARKER.length : tagEnd + 1
    const objectStart = content.indexOf('{', bodyStart)
    if (objectStart === -1) break
    const extracted = extractBalancedJsonLikeObject(content, objectStart)
    if (!extracted) {
      cursor = objectStart + 1
      continue
    }
    payloads.push(extracted.text)
    cursor = extracted.end
  }
  return payloads
}

function extractBalancedJsonLikeObject(content: string, start: number): { text: string; end: number } | null {
  let depth = 0
  let quote: '"' | "'" | '“' | '‘' | null = null
  let escaped = false
  for (let idx = start; idx < content.length; idx += 1) {
    const ch = content[idx]
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (
        ch === quote ||
        (quote === '“' && ch === '”') ||
        (quote === '‘' && ch === '’')
      ) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '“' || ch === '‘') {
      quote = ch as '"' | "'" | '“' | '‘'
      continue
    }
    if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return {
          text: content.slice(start, idx + 1),
          end: idx + 1,
        }
      }
    }
  }
  return null
}

function parseTextToolCall(rawJson: string): NanobotToolCall | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(normalizeJsonLikeToolCall(rawJson))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) return null
  const args = parseToolArguments(raw.arguments)
  return {
    id: `codex_text_tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

function normalizeJsonLikeToolCall(rawJson: string): string {
  const normalized = rawJson
    .trim()
    .replace(/[\u201C\u201D]/gu, '"')
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/^\uFEFF/u, '')
  return escapeInvalidJsonBackslashes(escapeLiteralNewlinesInJsonStrings(normalized))
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(normalizeJsonLikeToolCall(value))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  }
  return {}
}

function escapeInvalidJsonBackslashes(value: string): string {
  let out = ''
  for (let idx = 0; idx < value.length; idx += 1) {
    const ch = value[idx]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = value[idx + 1] ?? ''
    if (/["\\/bfnrtu]/u.test(next)) {
      out += ch
      if (next) {
        out += next
        idx += 1
      }
    } else {
      out += '\\\\'
    }
  }
  return out
}

function escapeLiteralNewlinesInJsonStrings(value: string): string {
  let quote = false
  let escaped = false
  let out = ''
  for (const ch of value) {
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      quote = !quote
      out += ch
      continue
    }
    if (quote && ch === '\n') {
      out += '\\n'
      continue
    }
    if (quote && ch === '\r') {
      out += '\\r'
      continue
    }
    out += ch
  }
  return out
}

function codexModel(prepared: BrowserCodexPrepare): string {
  const configured = stringSetting(prepared.codex_settings?.model)
  if (configured) return configured
  return prepared.model === 'codex' ? '' : prepared.model
}

function codexServiceTier(prepared: BrowserCodexPrepare): string {
  return stringSetting(prepared.codex_settings?.service_tier)
}

function codexEffort(prepared: BrowserCodexPrepare): ProviderDraft['codex_effort'] | '' {
  const value = stringSetting(prepared.codex_settings?.effort)
  if (value === 'minimal') return 'low'
  return isOneOf(value, ['none', 'low', 'medium', 'high', 'xhigh']) ? value as ProviderDraft['codex_effort'] : ''
}

function codexSummary(prepared: BrowserCodexPrepare): ProviderDraft['codex_summary'] | '' {
  const value = stringSetting(prepared.codex_settings?.summary)
  return isOneOf(value, ['none', 'auto', 'concise', 'detailed']) ? value as ProviderDraft['codex_summary'] : ''
}

function codexSandbox(prepared: BrowserCodexPrepare): ProviderDraft['codex_sandbox'] {
  const value = stringSetting(prepared.codex_settings?.sandbox)
  return isOneOf(value, ['read-only', 'workspace-write', 'danger-full-access'])
    ? value as ProviderDraft['codex_sandbox']
    : 'read-only'
}

function codexApprovalPolicy(prepared: BrowserCodexPrepare): ProviderDraft['codex_approval_policy'] {
  const value = stringSetting(prepared.codex_settings?.approval_policy)
  return isOneOf(value, ['never', 'untrusted', 'on-request', 'on-failure'])
    ? value as ProviderDraft['codex_approval_policy']
    : 'never'
}

function stringSetting(value: unknown): string {
  return stringValue(value)
}

function isOneOf(value: string, allowed: string[]): boolean {
  return allowed.includes(value)
}

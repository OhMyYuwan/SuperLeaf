/**
 * MCP helpers: runtime-config parsing, transport/policy evaluation, preset and
 * owned-server naming, health summaries and market filtering. Pure functions +
 * the shared `McpCheckState` type used by the MCP management components.
 */

import type {
  McpExecutionPolicy,
  McpGoldenTestResult,
  McpPreset,
  McpProbeResult,
  NativeAgentMcpServer,
  NativeMcpServerConfig,
} from '../../../services/backendApi'
import { asRecord, joinArgs, stringArray } from './meta'
import { DEFAULT_MCP_POLICY } from './constants'

export type McpCheckState = {
  busy: 'probe' | 'golden' | null
  probe?: McpProbeResult
  golden?: McpGoldenTestResult
  error?: string
}

type ParsedMcpJson = {
  id: string
  name: string
  description: string
  command: string
  args: string[]
  env: Record<string, string>
  allowedTools: string[]
}

export function parseEnvLines(value: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of value.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key.trim()) env[key.trim()] = rest.join('=').trim()
  }
  return env
}

export function parseEnvLinesStrict(value: string): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {}
  const lines = value.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) continue
    if (!trimmed.includes('=')) {
      return { env, error: `Env 第 ${index + 1} 行需要使用 KEY=value` }
    }
    const [key, ...rest] = trimmed.split('=')
    const cleanKey = key.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanKey)) {
      return { env, error: `Env 第 ${index + 1} 行的 KEY 无效` }
    }
    env[cleanKey] = rest.join('=').trim()
  }
  return { env }
}

export function parseDelimitedList(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))]
}

export function parseMcpJsonSnippet(value: string): { parsed?: ParsedMcpJson; error?: string } {
  let root: unknown
  try {
    root = JSON.parse(value)
  } catch {
    return { error: 'JSON 格式无效' }
  }
  const rootRecord = asRecord(root)
  if (!rootRecord) return { error: 'JSON 顶层需要是对象' }

  const extract = (): { id: string; config: Record<string, unknown> } | null => {
    const mcpServers = asRecord(rootRecord.mcpServers)
    if (mcpServers) {
      const entries = Object.entries(mcpServers).filter(([, config]) => asRecord(config))
      if (entries.length !== 1) return null
      return { id: entries[0][0], config: asRecord(entries[0][1]) || {} }
    }
    if ('command' in rootRecord || 'args' in rootRecord || 'env' in rootRecord) {
      return { id: String(rootRecord.id || rootRecord.name || ''), config: rootRecord }
    }
    const entries = Object.entries(rootRecord).filter(([, config]) => asRecord(config))
    if (entries.length === 1) return { id: entries[0][0], config: asRecord(entries[0][1]) || {} }
    return null
  }

  const extracted = extract()
  if (!extracted) return { error: '一次只支持粘贴一个 stdio MCP server 配置' }

  const typeValue = String(extracted.config.type || extracted.config.transport || 'stdio').toLowerCase()
  if (typeValue && typeValue !== 'stdio') return { error: '当前粘贴入口只支持 stdio MCP JSON' }

  const commandValue = extracted.config.command
  const command = Array.isArray(commandValue)
    ? String(commandValue[0] || '').trim()
    : String(commandValue || '').trim()
  if (!command) return { error: 'JSON 中缺少 command' }
  const commandArgs = Array.isArray(commandValue) ? commandValue.slice(1).map(String) : []
  const args = [...commandArgs, ...stringArray(extracted.config.args)]
  const envRecord = asRecord(extracted.config.env) || asRecord(extracted.config.environment) || {}
  const env = Object.fromEntries(
    Object.entries(envRecord).map(([key, val]) => [key, String(val)]).filter(([key]) => key.trim()),
  )
  const allowedTools = stringArray(extracted.config.allowed_tools || extracted.config.allowedTools)
  const id = extracted.id.trim()
  const name = String(extracted.config.name || id || command).trim()
  const description = String(extracted.config.description || '').trim()
  return { parsed: { id, name, description, command, args, env, allowedTools } }
}

export function mcpServersFromRuntime(runtimeConfig: Record<string, unknown> | undefined): NativeAgentMcpServer[] {
  const value = runtimeConfig?.mcp_servers
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      id: String(item.id || item.name || '').trim(),
      name: String(item.name || item.id || '').trim(),
      enabled: item.enabled !== false,
      transport: String(item.transport || (item.endpoint ? 'remote' : 'stdio')),
      endpoint: String(item.endpoint || item.url || '').trim(),
      command: String(item.command || '').trim(),
      args: Array.isArray(item.args) ? item.args.map(String).filter(Boolean) : [],
      env: item.env && typeof item.env === 'object' && !Array.isArray(item.env) ? Object.fromEntries(
        Object.entries(item.env as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
      ) : {},
      allowed_tools: Array.isArray(item.allowed_tools) ? item.allowed_tools.map(String).filter(Boolean) : [],
    }))
    .filter((server) => server.id && (server.command || server.endpoint))
}

function stringListFromRuntime(runtimeConfig: Record<string, unknown> | undefined, key: string): string[] {
  const value = runtimeConfig?.[key]
  if (!Array.isArray(value)) return []
  return value.map(String).map((item) => item.trim()).filter(Boolean)
}

export function mcpPresetIdsFromRuntime(runtimeConfig: Record<string, unknown> | undefined): string[] {
  return stringListFromRuntime(runtimeConfig, 'mcp_preset_ids')
}

export function mcpServerIdsFromRuntime(runtimeConfig: Record<string, unknown> | undefined): string[] {
  return stringListFromRuntime(runtimeConfig, 'mcp_server_ids')
}

export function writeMcpSelection(
  runtimeConfig: Record<string, unknown> | undefined,
  presetIds: string[],
  serverIds: string[],
): Record<string, unknown> {
  // Drop the legacy inline `mcp_servers` block; selection is reference-based.
  const rest = { ...(runtimeConfig ?? {}) }
  delete rest.mcp_servers
  return {
    ...rest,
    mcp_preset_ids: [...new Set(presetIds)],
    mcp_server_ids: [...new Set(serverIds)],
  }
}

export function mcpEffectivePolicy(policy: McpExecutionPolicy | null | undefined): McpExecutionPolicy {
  return policy ?? DEFAULT_MCP_POLICY
}

export function mcpTransportKind(value: string | undefined | null): 'remote' | 'stdio' | 'unsupported' {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-')
  if (['remote', 'http', 'https', 'sse', 'streamable-http'].includes(normalized)) return 'remote'
  if (!normalized || ['stdio', 'local', 'local-stdio'].includes(normalized)) return 'stdio'
  return 'unsupported'
}

export function mcpTransportLabel(value: string | undefined | null): string {
  const kind = mcpTransportKind(value)
  if (kind === 'remote') return 'REMOTE'
  if (kind === 'stdio') return 'STDIO'
  return String(value || 'UNKNOWN').toUpperCase()
}

export function mcpTransportAllowed(value: string | undefined | null, policy: McpExecutionPolicy): boolean {
  const kind = mcpTransportKind(value)
  if (kind === 'remote') return policy.remote_enabled
  if (kind === 'stdio') return policy.stdio_enabled
  return false
}

export function mcpTransportPolicyBlock(value: string | undefined | null, policy: McpExecutionPolicy): string {
  const kind = mcpTransportKind(value)
  if (kind === 'remote' && !policy.remote_enabled) return '当前部署未开启 Remote MCP endpoint。'
  if (kind === 'stdio' && !policy.stdio_enabled) return '当前部署未开启 Local Trusted MCP（YLW_MCP_STDIO_ENABLED=false）。'
  if (kind === 'unsupported') return `当前部署不支持 ${String(value || 'unknown')} MCP transport。`
  return ''
}

export function mcpServerTransportKind(server: NativeMcpServerConfig | NativeAgentMcpServer): 'remote' | 'stdio' | 'unsupported' {
  return mcpTransportKind(server.transport || (server.endpoint ? 'remote' : 'stdio'))
}

export function mcpServerAllowedByPolicy(server: NativeMcpServerConfig | NativeAgentMcpServer, policy: McpExecutionPolicy): boolean {
  return mcpTransportAllowed(server.transport || (server.endpoint ? 'remote' : 'stdio'), policy)
}

export function mcpServerPolicyBlock(server: NativeMcpServerConfig | NativeAgentMcpServer, policy: McpExecutionPolicy): string {
  return mcpTransportPolicyBlock(server.transport || (server.endpoint ? 'remote' : 'stdio'), policy)
}

export function mcpPresetTransportKind(preset: McpPreset): 'remote' | 'stdio' | 'unsupported' {
  return mcpTransportKind(preset.transport.type || (mcpPresetEndpoint(preset) ? 'remote' : 'stdio'))
}

export function mcpPresetPolicyBlock(preset: McpPreset, policy: McpExecutionPolicy): string {
  return mcpTransportPolicyBlock(preset.transport.type || (mcpPresetEndpoint(preset) ? 'remote' : 'stdio'), policy)
}

export function mcpPresetEndpoint(preset: McpPreset): string {
  return String(preset.transport.endpoint || preset.transport.url || '').trim()
}

export function mcpServerEndpoint(server: NativeMcpServerConfig | NativeAgentMcpServer): string {
  return String(server.endpoint || (mcpServerTransportKind(server) === 'remote' ? server.command : '') || '').trim()
}

export function mcpPresetTargetLine(preset: McpPreset): string {
  if (mcpPresetTransportKind(preset) === 'remote') return mcpPresetEndpoint(preset) || preset.transport.command || '(empty)'
  return preset.transport.command || '(empty)'
}

export function mcpServerTargetLine(server: NativeMcpServerConfig): string {
  if (mcpServerTransportKind(server) === 'remote') return mcpServerEndpoint(server) || '(empty endpoint)'
  return `${server.command} ${joinArgs(server.args)}`.trim() || '(empty command)'
}

export function mcpNameFromEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return url.hostname.replace(/^www\./, '') || 'remote-mcp'
  } catch {
    return endpoint.replace(/^https?:\/\//i, '').split('/')[0] || 'remote-mcp'
  }
}

export function serverFromPreset(preset: McpPreset): NativeAgentMcpServer {
  const transport = mcpPresetTransportKind(preset)
  const endpoint = transport === 'remote' ? mcpPresetEndpoint(preset) || preset.transport.command : ''
  return {
    id: preset.id,
    name: mcpQualifiedName(preset),
    enabled: true,
    transport: transport === 'unsupported' ? preset.transport.type || 'stdio' : transport,
    endpoint,
    command: transport === 'remote' ? endpoint : preset.transport.command,
    args: transport === 'remote' ? [] : preset.transport.args ?? [],
    env: {},
    allowed_tools: preset.tool_policy.default_allowed_tools ?? preset.tool_policy.recommended_tools ?? [],
  }
}

export function mcpQualifiedName(preset: McpPreset): string {
  if (preset.qualified_name?.trim()) return preset.qualified_name.trim()
  if (preset.name.includes('@')) return preset.name
  const owner = preset.owner?.trim() || mcpOwnerFromSource(preset) || 'external'
  return `${owner}@${preset.name}`
}

function mcpOwnerFromSource(preset: McpPreset): string {
  const repo = preset.source?.repo
  if (typeof repo === 'string' && repo.includes('/')) return repo.split('/')[0]
  return ''
}

export function mcpRegistryLabel(preset: McpPreset): string {
  return preset.registry === 'official' ? '官方' : '外部'
}

export function isOfficialRecommendedMcp(preset?: McpPreset): boolean {
  return Boolean(preset?.official_recommended || preset?.registry === 'official')
}

export function ownedMcpName(server: NativeMcpServerConfig, preset?: McpPreset): string {
  if (preset) return mcpQualifiedName(preset)
  if (server.name.includes('@')) return server.name
  const owner = mcpServerTransportKind(server) === 'remote' ? 'remote' : 'local'
  const base = (server.name || mcpServerEndpoint(server) || server.command || 'custom-mcp').trim()
  return `${owner}@${base}`
}

function goldenPassed(check?: McpCheckState): boolean {
  return Boolean(check?.golden?.passed)
}

function connectivityPassed(check?: McpCheckState): boolean {
  return check?.probe?.status === 'ok'
}

export function mcpPresetSourceLabel(preset: McpPreset): string {
  const repo = preset.source?.repo
  if (typeof repo === 'string' && repo.trim()) return repo
  const url = preset.source?.url
  if (typeof url === 'string' && url.trim()) return url
  return 'custom preset'
}

export function mcpPresetSourceUrl(preset: McpPreset): string {
  const url = preset.source?.url
  if (typeof url === 'string' && url.trim()) {
    const safeUrl = safeHttpUrl(url)
    if (safeUrl) return safeUrl
  }
  const repo = preset.source?.repo
  if (typeof repo === 'string') {
    const cleanRepo = repo.trim()
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleanRepo)) {
      return `https://github.com/${cleanRepo}`
    }
  }
  return ''
}

function safeHttpUrl(value: string): string {
  const trimmed = value.trim()
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : ''
  } catch {
    return ''
  }
}

export function mcpPresetEnvSummary(preset: McpPreset): string {
  if (preset.env_schema.length === 0) return '无 Env'
  const required = preset.env_schema.filter((field) => field.required)
  const reliable = preset.env_schema.filter((field) => field.required_for_reliable_use && !field.required)
  if (required.length > 0) return `必填 Env: ${required.map((field) => field.name).join(', ')}`
  if (reliable.length > 0) return `推荐 Env: ${reliable.map((field) => field.name).join(', ')}`
  return `Env: ${preset.env_schema.map((field) => field.name).join(', ')}`
}

export function mcpPresetVerificationSummary(preset: McpPreset): string {
  const status = preset.verification.status || 'unknown'
  const grade = preset.verification.grade ? ` · ${preset.verification.grade}` : ''
  const golden = preset.verification.golden_tests?.length ? ` · ${preset.verification.golden_tests.length} golden` : ''
  return `${status}${grade}${golden}`
}

export function mcpPresetAllowedTools(preset: McpPreset): string[] {
  return preset.tool_policy.default_allowed_tools?.length
    ? preset.tool_policy.default_allowed_tools
    : preset.tool_policy.recommended_tools ?? []
}

export function mcpPresetTransportLabel(preset: McpPreset): string {
  return mcpTransportLabel(preset.transport.type || (mcpPresetEndpoint(preset) ? 'remote' : 'stdio'))
}

export function mcpPresetTransportSupported(preset: McpPreset, policy: McpExecutionPolicy): boolean {
  return mcpTransportAllowed(preset.transport.type || (mcpPresetEndpoint(preset) ? 'remote' : 'stdio'), policy)
}

function mcpProbeDetailText(probe: McpProbeResult): string {
  const warning = probe.warnings.length > 0 ? `; ${probe.warnings.join('; ')}` : ''
  const missing = probe.missing_tools.length > 0 ? `; missing: ${probe.missing_tools.join(', ')}` : ''
  return `${probe.tools.length} tools${missing}${warning}`
}

export function mcpConnectivityOk(server: NativeMcpServerConfig, check?: McpCheckState): boolean {
  return connectivityPassed(check) || (!check && (server.last_probe_status || server.status) === 'ok')
}

export function mcpFunctionalityOk(server: NativeMcpServerConfig, check?: McpCheckState): boolean {
  return goldenPassed(check) || (!check && server.last_golden_status === 'ok')
}

export function mcpServerHealthLine(server: NativeMcpServerConfig, check?: McpCheckState): string {
  if (check?.busy === 'probe') return '最近检查：连通性检查中'
  if (check?.busy === 'golden') return '最近检查：功能性检查中'
  const parts: string[] = []
  if (check?.probe) {
    parts.push(`连通性 ${check.probe.status} · ${mcpProbeDetailText(check.probe)}`)
  } else {
    const status = server.last_probe_status || (server.status !== 'unknown' ? server.status : '')
    const detail = server.last_probe_detail || server.status_detail
    if (status) parts.push(`连通性 ${status}${detail ? ` · ${detail}` : ''}`)
  }
  if (check?.golden) {
    const detail = check.golden.error || check.golden.warnings?.join('; ') || check.golden.test_id
    parts.push(`功能性 ${check.golden.passed ? 'ok' : 'error'}${detail ? ` · ${detail}` : ''}`)
  } else if (server.last_golden_status) {
    parts.push(`功能性 ${server.last_golden_status}${server.last_golden_detail ? ` · ${server.last_golden_detail}` : ''}`)
  }
  return parts.length ? `最近检查：${parts.join(' ｜ ')}` : ''
}

export function mcpAgentPickerHint(
  server: NativeMcpServerConfig,
  preset: McpPreset | undefined,
  policy: McpExecutionPolicy,
): { label: string; detail: string; tone: 'ok' | 'warn' | 'error' | 'neutral' } {
  if (!server.is_enabled) {
    return { label: '停用', detail: '不会在未选中时开放', tone: 'neutral' }
  }
  const policyBlock = mcpServerPolicyBlock(server, policy)
  if (policyBlock) {
    return { label: 'blocked', detail: policyBlock, tone: 'warn' }
  }
  const status = server.last_probe_status || server.status
  if (status === 'ok') {
    return { label: 'ready', detail: server.last_probe_detail || `${server.last_tool_count || 0} tools`, tone: 'ok' }
  }
  if (status === 'error') {
    return { label: 'failed', detail: server.last_probe_detail || server.status_detail || '连通性失败', tone: 'error' }
  }
  const requiredEnv = preset?.env_schema.filter((field) => field.required || field.required_for_reliable_use) ?? []
  const missingEnv = requiredEnv.filter((field) => !server.env_keys.includes(field.name))
  if (missingEnv.length > 0) {
    return { label: 'needs config', detail: `缺少 ${missingEnv.map((field) => field.name).join(', ')}`, tone: 'warn' }
  }
  return { label: 'unchecked', detail: '尚未运行连通性检查', tone: 'neutral' }
}

export function envPlaceholderForPreset(preset?: McpPreset): string {
  if (!preset || preset.env_schema.length === 0) return 'KEY=value'
  return preset.env_schema.map((field) => `${field.name}=`).join('\n')
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'MCP 操作失败'
}

export function mcpMarketMatches(preset: McpPreset, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const sourceValues = Object.values(preset.source ?? {}).filter((value) => typeof value === 'string')
  const haystack = [
    preset.id,
    preset.name,
    preset.owner,
    preset.qualified_name,
    mcpQualifiedName(preset),
    mcpRegistryLabel(preset),
    preset.registry,
    preset.category,
    preset.description,
    preset.verification.status,
    preset.verification.grade,
    ...preset.capabilities,
    ...sourceValues,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(normalized)
}

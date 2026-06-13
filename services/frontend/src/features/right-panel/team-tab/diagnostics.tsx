/**
 * Local Host diagnostics: probing endpoints (/health, MCP status, install
 * status, Codex/Claude/Nanobot) and rendering the results. Used by the agents
 * sub-tab in the TeamTab container.
 */

import { useMemo, useState } from 'react'
import { CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react'
import type { LocalAgentHostPackageInfo, Provider } from '../../../services/backendApi'
import {
  DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT,
  probeBrowserNanobotTools,
} from '../../../services/nanobotBrowserClient'
import { listBrowserCodexSessions } from '../../../services/codexBrowserClient'
import { listBrowserClaudeSessions } from '../../../services/claudeBrowserClient'
import { normalizeLocalAgentHostEndpoint } from '../../../services/browserToolBridge'
import {
  arrayLength,
  numberRecordValue,
  objectMeta,
  stringRecordValue,
} from './meta'
import {
  compactEndpointLabel,
  formatBytes,
  formatDiagnosticTime,
  shortChecksum,
  shortDiagnosticId,
} from './format'

export type LocalHostEndpointGroup = {
  endpoint: string
  providers: Provider[]
  hasCodex: boolean
  hasClaude: boolean
  hasNanobot: boolean
}

type DiagnosticProbe<T extends Record<string, unknown> = Record<string, unknown>> = {
  ok: boolean
  value?: T
  error?: string
}

export type LocalHostEndpointDiagnostic = {
  loading?: boolean
  updatedAt?: string
  host?: DiagnosticProbe
  mcpStatus?: DiagnosticProbe
  codexHealth?: DiagnosticProbe
  codexSessions?: DiagnosticProbe
  claudeHealth?: DiagnosticProbe
  claudeSessions?: DiagnosticProbe
  nanobotTools?: DiagnosticProbe
  installStatus?: DiagnosticProbe
}

export function LocalHostInstallPanel({
  packageInfo,
  loading,
  error,
  downloading,
  onDownload,
}: {
  packageInfo: LocalAgentHostPackageInfo | null
  loading: boolean
  error: string | null
  downloading: boolean
  onDownload: () => void | Promise<void>
}) {
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verifyResult, setVerifyResult] = useState<LocalHostEndpointDiagnostic | null>(null)
  const codexAutoMcp = packageInfo?.codex_env?.SL_LOCAL_AGENT_HOST_CODEX_AUTO_MCP ?? '1'
  const endpoint = packageInfo?.endpoint ?? 'http://127.0.0.1:8787'
  const packageLabel = packageInfo
    ? `${packageInfo.filename} · ${formatBytes(packageInfo.size_bytes)}`
    : 'superleaf-local-agent-host.zip'
  const checksumLabel = packageInfo?.sha256
    ? `${packageInfo.checksum_algorithm || 'sha256'}:${shortChecksum(packageInfo.sha256)}`
    : '等待后端返回'
  const runInstallProbe = async () => {
    if (verifyBusy) return
    setVerifyBusy(true)
    setVerifyResult({ loading: true })
    try {
      const [host, mcpStatus, installStatus] = await Promise.all([
        settleDiagnostic(() => fetchLocalHostJson(endpoint, '/health')),
        settleDiagnostic(() => fetchLocalHostJson(endpoint, '/superleaf/mcp/status')),
        settleDiagnostic(() => fetchLocalHostJson(endpoint, '/superleaf/install/status')),
      ])
      setVerifyResult({
        loading: false,
        updatedAt: new Date().toISOString(),
        host,
        mcpStatus,
        installStatus,
      })
    } finally {
      setVerifyBusy(false)
    }
  }
  return (
    <section className="local-host-install-panel">
      <div className="local-host-install-head">
        <div>
          <h3>Codex / Claude 本地安装</h3>
          <p>
            下载 Local Agent Host，在用户电脑上启动后，SuperLeaf 才能通过浏览器连接本机 Codex、Claude 或 Nanobot。
          </p>
        </div>
        <div className="local-host-install-actions">
          <button
            className="small-btn"
            onClick={() => void onDownload()}
            disabled={downloading}
            title="下载 SuperLeaf Local Agent Host"
          >
            {downloading ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
            下载
          </button>
          <button
            className="small-btn"
            onClick={() => void runInstallProbe()}
            disabled={verifyBusy}
            title="验证默认 Local Host 是否已在本机启动"
          >
            {verifyBusy ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={12} />}
            验证启动
          </button>
        </div>
      </div>
      {loading && <div className="local-host-install-note">正在读取安装包信息...</div>}
      {error && <div className="local-host-install-error">{error}</div>}
      <div className="local-host-install-grid">
        <div className="local-host-install-card">
          <span>安装包</span>
          <strong title={packageLabel}>{packageLabel}</strong>
          <code>{packageInfo?.endpoint ?? 'http://127.0.0.1:8787'}</code>
          <code>{packageInfo?.mcp_url ?? 'http://127.0.0.1:8787/mcp'}</code>
        </div>
        <div className="local-host-install-card">
          <span>校验</span>
          <strong title={packageInfo?.sha256 ?? checksumLabel}>{checksumLabel}</strong>
          <code>{packageInfo?.manifest_filename ?? 'superleaf-local-agent-host.manifest.json'}</code>
          <code>{packageInfo ? `${packageInfo.included_files.length} files` : 'manifest pending'}</code>
        </div>
        <div className="local-host-install-card">
          <span>macOS</span>
          <code>{packageInfo?.macos.background ?? 'start-local-agent-host-background.command'}</code>
          <code>{packageInfo?.macos.stop ?? 'stop-local-agent-host.command'}</code>
          <code>{packageInfo?.macos.install_start_at_login ?? 'install-local-agent-host-startup.command'}</code>
        </div>
        <div className="local-host-install-card">
          <span>Windows</span>
          <code>{packageInfo?.windows.background ?? 'start-local-agent-host-background.cmd'}</code>
          <code>{packageInfo?.windows.stop ?? 'stop-local-agent-host.cmd'}</code>
          <code>{packageInfo?.windows.install_start_at_login ?? 'install-local-agent-host-startup.cmd'}</code>
        </div>
        <div className="local-host-install-card">
          <span>Agent 开关</span>
          <code>CODEX_ENABLED={packageInfo?.codex_env?.SL_LOCAL_AGENT_HOST_CODEX_ENABLED ?? '1'}</code>
          <code>CODEX_AUTO_MCP={codexAutoMcp}</code>
          <code>CLAUDE_ENABLED={packageInfo?.claude_env?.SL_LOCAL_AGENT_HOST_CLAUDE_ENABLED ?? '1'}</code>
        </div>
      </div>
      {packageInfo && (
        <div className="local-host-install-foot">
          包含 {packageInfo.included_files.length} 个文件，包括 Windows launcher、MCP 工具 manifest、安装 manifest 和 smoke/matrix 诊断脚本。
        </div>
      )}
      <LocalHostInstallProbeResult result={verifyResult} endpoint={endpoint} />
    </section>
  )
}

function LocalHostInstallProbeResult({
  result,
  endpoint,
}: {
  result: LocalHostEndpointDiagnostic | null
  endpoint: string
}) {
  if (!result) return null
  const host = result.host?.value ?? {}
  const mcpStatus = result.mcpStatus?.value ?? {}
  const installStatus = result.installStatus?.value ?? {}
  const startAtLogin = objectMeta(installStatus, 'start_at_login')
  const hostStatus = stringRecordValue(host, 'status') || (result.loading ? '检测中' : '未连接')
  const mcpTools = numberRecordValue(mcpStatus, 'tool_count') || numberRecordValue(host, 'superleaf_mcp_tool_count')
  const contexts = arrayLength(mcpStatus.contexts) || numberRecordValue(host, 'mcp_contexts')
  const pending = arrayLength(mcpStatus.pending_calls) || numberRecordValue(host, 'mcp_pending_calls')
  const startupStatus = stringRecordValue(startAtLogin, 'status') || (result.installStatus ? 'unknown' : '未检测')
  const startupConfigured = Boolean(startAtLogin.configured)
  const packageVersion = stringRecordValue(installStatus, 'package_version')
  const errors = diagnosticErrors(result)
  const hostTone: 'ok' | 'warn' | 'neutral' = result.host?.ok && hostStatus === 'ok' ? 'ok' : result.host ? 'warn' : 'neutral'
  const mcpTone: 'ok' | 'warn' | 'neutral' = result.mcpStatus?.ok && mcpTools > 0 ? 'ok' : result.mcpStatus ? 'warn' : 'neutral'
  const startupTone: 'ok' | 'warn' | 'neutral' = startupConfigured ? 'ok' : result.installStatus?.ok ? 'neutral' : result.installStatus ? 'warn' : 'neutral'
  return (
    <div className={`local-host-install-probe ${result.loading ? 'loading' : ''}`}>
      <div className="local-host-install-probe-top">
        <strong title={endpoint}>{compactEndpointLabel(endpoint)}</strong>
        {result.updatedAt && <time>{formatDiagnosticTime(result.updatedAt)}</time>}
      </div>
      <div className="local-host-diagnostic-pills">
        <DiagnosticPill tone={hostTone}>Host {hostStatus}</DiagnosticPill>
        <DiagnosticPill tone={mcpTone}>MCP tools {mcpTools || '-'}</DiagnosticPill>
        <DiagnosticPill tone={startupTone}>Startup {startupStatus}</DiagnosticPill>
        <DiagnosticPill tone={contexts > 0 ? 'ok' : 'neutral'}>contexts {contexts}</DiagnosticPill>
        <DiagnosticPill tone={pending > 0 ? 'warn' : 'neutral'}>pending {pending}</DiagnosticPill>
      </div>
      <div className="local-host-install-probe-grid">
        <span>version: {packageVersion || '-'}</span>
        <span>data: {compactEndpointLabel(stringRecordValue(installStatus, 'data_dir') || '-')}</span>
        <span>pid: {numberRecordValue(installStatus, 'pid') || '-'}</span>
        <span>manifest: {installStatus.manifest_present ? 'present' : '-'}</span>
      </div>
      {errors.length > 0 && (
        <div className="local-host-diagnostic-errors">
          {errors.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}
    </div>
  )
}

export function LocalHostDiagnosticsPanel({ providers }: { providers: Provider[] }) {
  const endpoints = useMemo(() => groupLocalHostEndpoints(providers), [providers])
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, LocalHostEndpointDiagnostic>>({})

  const runDiagnostics = async () => {
    if (busy) return
    setExpanded(true)
    setBusy(true)
    setResults((prev) => {
      const next = { ...prev }
      for (const group of endpoints) {
        next[group.endpoint] = { ...(next[group.endpoint] ?? {}), loading: true }
      }
      return next
    })
    try {
      const entries = await Promise.all(
        endpoints.map(async (group) => [group.endpoint, await probeLocalHostEndpoint(group)] as const),
      )
      setResults((prev) => ({ ...prev, ...Object.fromEntries(entries) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="local-host-diagnostics">
      <div className="local-host-diagnostics-head">
        <div>
          <h3>Local Host 诊断</h3>
          <p>{endpoints.length > 0 ? `${endpoints.length} 个本机 endpoint` : '尚未配置本机 Agent endpoint'}</p>
        </div>
        <div className="local-host-diagnostics-actions">
          <button
            className="small-btn"
            onClick={() => setExpanded((value) => !value)}
            disabled={endpoints.length === 0}
          >
            {expanded ? '收起' : '展开'}
          </button>
          <button
            className="small-btn"
            onClick={() => void runDiagnostics()}
            disabled={busy || endpoints.length === 0}
          >
            {busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
            诊断
          </button>
        </div>
      </div>
      {expanded && endpoints.length > 0 && (
        <div className="local-host-diagnostics-list">
          {endpoints.map((group) => (
            <LocalHostDiagnosticCard
              key={group.endpoint}
              group={group}
              result={results[group.endpoint]}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function LocalHostDiagnosticCard({
  group,
  result,
}: {
  group: LocalHostEndpointGroup
  result?: LocalHostEndpointDiagnostic
}) {
  const host = result?.host?.value ?? {}
  const mcpStatus = result?.mcpStatus?.value ?? {}
  const codexHealth = result?.codexHealth?.value ?? {}
  const claudeHealth = result?.claudeHealth?.value ?? {}
  const nanobotTools = result?.nanobotTools?.value ?? {}
  const installStatus = result?.installStatus?.value ?? {}
  const startAtLogin = objectMeta(installStatus, 'start_at_login')
  const hostStatus = stringRecordValue(host, 'status')
  const service = stringRecordValue(host, 'service') || 'Local Agent Host'
  const mcpTools = numberRecordValue(mcpStatus, 'tool_count') || numberRecordValue(host, 'superleaf_mcp_tool_count')
  const contexts = arrayLength(mcpStatus.contexts) || numberRecordValue(host, 'mcp_contexts')
  const pending = arrayLength(mcpStatus.pending_calls) || numberRecordValue(host, 'mcp_pending_calls')
  const startupStatus = stringRecordValue(startAtLogin, 'status') || (result?.installStatus ? 'unknown' : '未检测')
  const startupConfigured = Boolean(startAtLogin.configured)
  const packageVersion = stringRecordValue(installStatus, 'package_version')
  const codexSessionCount = diagnosticSessionCount(result?.codexSessions)
  const claudeSessionCount = diagnosticSessionCount(result?.claudeSessions)
  const nanobotToolCount = numberRecordValue(nanobotTools, 'superleaf_mcp_tool_count') ||
    numberRecordValue(objectMeta(nanobotTools, 'adapter'), 'tool_count')
  const errors = diagnosticErrors(result)
  const startupTone: 'ok' | 'warn' | 'neutral' = startupConfigured ? 'ok' : result?.installStatus?.ok ? 'neutral' : result?.installStatus ? 'warn' : 'neutral'
  return (
    <div className={`local-host-diagnostic-card ${result?.loading ? 'loading' : ''}`}>
      <div className="local-host-diagnostic-top">
        <div>
          <strong title={group.endpoint}>{compactEndpointLabel(group.endpoint)}</strong>
          <span>{group.providers.map((provider) => provider.name).join(' · ')}</span>
        </div>
        {result?.updatedAt && <time>{formatDiagnosticTime(result.updatedAt)}</time>}
      </div>
      <div className="local-host-diagnostic-pills">
        <DiagnosticPill tone={result?.host?.ok && hostStatus === 'ok' ? 'ok' : result?.host ? 'warn' : 'neutral'}>
          Host {hostStatus || '未检测'}
        </DiagnosticPill>
        <DiagnosticPill tone={result?.mcpStatus?.ok ? 'ok' : result?.mcpStatus ? 'warn' : 'neutral'}>
          MCP tools {mcpTools || '-'}
        </DiagnosticPill>
        <DiagnosticPill tone={startupTone}>Startup {startupStatus}</DiagnosticPill>
        {group.hasCodex && (
          <DiagnosticPill tone={result?.codexHealth?.ok && stringRecordValue(codexHealth, 'status') === 'ok' ? 'ok' : result?.codexHealth ? 'warn' : 'neutral'}>
            Codex {stringRecordValue(codexHealth, 'status') || '未检测'}
          </DiagnosticPill>
        )}
        {group.hasClaude && (
          <DiagnosticPill tone={result?.claudeHealth?.ok && stringRecordValue(claudeHealth, 'status') === 'ok' ? 'ok' : result?.claudeHealth ? 'warn' : 'neutral'}>
            Claude {stringRecordValue(claudeHealth, 'status') || '未检测'}
          </DiagnosticPill>
        )}
        {group.hasNanobot && (
          <DiagnosticPill tone={nanobotToolCount > 0 ? 'ok' : result?.nanobotTools ? 'warn' : 'neutral'}>
            Nanobot tools {nanobotToolCount || '-'}
          </DiagnosticPill>
        )}
      </div>
      <div className="local-host-diagnostic-grid">
        <span>service: {service}</span>
        <span>contexts: {contexts}</span>
        <span>pending: {pending}</span>
        <span>version: {packageVersion || '-'}</span>
        <span>pid: {numberRecordValue(installStatus, 'pid') || '-'}</span>
        {group.hasCodex && <span>codex sessions: {codexSessionCount}</span>}
        {group.hasClaude && <span>claude sessions: {claudeSessionCount}</span>}
        {group.hasCodex && <span>codex thread: {shortDiagnosticId(latestSessionValue(result?.codexSessions, 'codex_thread_id')) || '-'}</span>}
        {group.hasClaude && <span>claude id: {shortDiagnosticId(latestSessionValue(result?.claudeSessions, 'claude_session_id')) || '-'}</span>}
      </div>
      {errors.length > 0 && (
        <div className="local-host-diagnostic-errors">
          {errors.map((error) => <span key={error}>{error}</span>)}
        </div>
      )}
    </div>
  )
}

function DiagnosticPill({ tone, children }: { tone: 'ok' | 'warn' | 'neutral'; children: React.ReactNode }) {
  return <span className={`native-pill ${tone === 'warn' ? 'neutral' : tone}`}>{children}</span>
}

function groupLocalHostEndpoints(providers: Provider[]): LocalHostEndpointGroup[] {
  const map = new Map<string, LocalHostEndpointGroup>()
  for (const provider of providers) {
    const isCodex = provider.kind === 'codex-local'
    const isClaude = provider.kind === 'claude-local'
    const isNanobot = provider.kind === 'nanobot' && provider.meta?.transport === 'browser'
    if (!isCodex && !isClaude && !isNanobot) continue
    const endpoint = normalizeLocalAgentHostEndpoint(
      isNanobot
        ? stringRecordValue(provider.meta, 'local_agent_host_endpoint') ||
          stringRecordValue(provider.meta, 'nanobot_adapter_endpoint') ||
          provider.endpoint ||
          DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT
        : provider.endpoint,
    )
    const current = map.get(endpoint) ?? {
      endpoint,
      providers: [],
      hasCodex: false,
      hasClaude: false,
      hasNanobot: false,
    }
    current.providers.push(provider)
    current.hasCodex ||= isCodex
    current.hasClaude ||= isClaude
    current.hasNanobot ||= isNanobot
    map.set(endpoint, current)
  }
  return [...map.values()]
}

async function probeLocalHostEndpoint(group: LocalHostEndpointGroup): Promise<LocalHostEndpointDiagnostic> {
  const [host, mcpStatus, installStatus, codexHealth, codexSessions, claudeHealth, claudeSessions, nanobotTools] = await Promise.all([
    settleDiagnostic(() => fetchLocalHostJson(group.endpoint, '/health')),
    settleDiagnostic(() => fetchLocalHostJson(group.endpoint, '/superleaf/mcp/status')),
    settleDiagnostic(() => fetchLocalHostJson(group.endpoint, '/superleaf/install/status')),
    group.hasCodex ? settleDiagnostic(() => fetchLocalHostJson(group.endpoint, '/codex/health')) : Promise.resolve(undefined),
    group.hasCodex ? settleDiagnostic(async () => listBrowserCodexSessions(group.endpoint, { limit: 5 }) as unknown as Record<string, unknown>) : Promise.resolve(undefined),
    group.hasClaude ? settleDiagnostic(() => fetchLocalHostJson(group.endpoint, '/claude/health')) : Promise.resolve(undefined),
    group.hasClaude ? settleDiagnostic(async () => listBrowserClaudeSessions(group.endpoint, { limit: 5 }) as unknown as Record<string, unknown>) : Promise.resolve(undefined),
    group.hasNanobot ? settleDiagnostic(async () => {
      const diagnostics = await probeBrowserNanobotTools(group.endpoint)
      return diagnostics
        ? diagnostics as unknown as Record<string, unknown>
        : { status: 'not_detected' }
    }) : Promise.resolve(undefined),
  ])
  return {
    loading: false,
    updatedAt: new Date().toISOString(),
    host,
    mcpStatus,
    installStatus,
    codexHealth,
    codexSessions,
    claudeHealth,
    claudeSessions,
    nanobotTools,
  }
}

async function fetchLocalHostJson(endpoint: string, path: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${normalizeLocalAgentHostEndpoint(endpoint)}${path}`, { method: 'GET' })
  const text = await resp.text()
  let payload: Record<string, unknown> = {}
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
    } catch {
      payload = { text }
    }
  }
  return {
    ...payload,
    http_status: resp.status,
    http_ok: resp.ok,
  }
}

async function settleDiagnostic<T extends Record<string, unknown>>(
  fn: () => Promise<T>,
): Promise<DiagnosticProbe<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function diagnosticSessionCount(probe?: DiagnosticProbe): number {
  const sessions = probe?.value?.sessions
  return Array.isArray(sessions) ? sessions.length : 0
}

function latestSessionValue(probe: DiagnosticProbe | undefined, key: string): string {
  const sessions = probe?.value?.sessions
  const latest = Array.isArray(sessions) ? sessions[0] : null
  return latest && typeof latest === 'object' && !Array.isArray(latest)
    ? String((latest as Record<string, unknown>)[key] || '')
    : ''
}

function diagnosticErrors(result?: LocalHostEndpointDiagnostic): string[] {
  if (!result) return []
  const entries: Array<[string, DiagnosticProbe | undefined]> = [
    ['Host', result.host],
    ['MCP', result.mcpStatus],
    ['Codex', result.codexHealth],
    ['Codex sessions', result.codexSessions],
    ['Claude', result.claudeHealth],
    ['Claude sessions', result.claudeSessions],
    ['Nanobot tools', result.nanobotTools],
    ['Install status', result.installStatus],
  ]
  return entries
    .filter(([, probe]) => probe && !probe.ok)
    .map(([label, probe]) => `${label}: ${probe?.error || 'failed'}`)
}

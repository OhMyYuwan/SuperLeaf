/**
 * MCP management components: the owned-server + market panel, the preset
 * install confirmation panel, the owned-server row, the server editor, the
 * custom (remote / stdio) MCP form, and the inline check result.
 */

import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type {
  McpExecutionPolicy,
  McpPreset,
  McpProbeResult,
  NativeMcpServerConfig,
  NativeMcpServerConfigDraft,
  NativeMcpServerConfigPatch,
} from '../../../services/backendApi'
import { nativeAgentApi } from '../../../services/backendApi'
import { OfficialMcpBadge } from './badges'
import { joinArgs, splitArgs } from './meta'
import type { McpCustomTab } from './constants'
import {
  type McpCheckState,
  envPlaceholderForPreset,
  errorMessage,
  isOfficialRecommendedMcp,
  mcpConnectivityOk,
  mcpEffectivePolicy,
  mcpFunctionalityOk,
  mcpMarketMatches,
  mcpNameFromEndpoint,
  mcpPresetAllowedTools,
  mcpPresetEnvSummary,
  mcpPresetPolicyBlock,
  mcpPresetSourceLabel,
  mcpPresetSourceUrl,
  mcpPresetTargetLine,
  mcpPresetTransportKind,
  mcpPresetTransportLabel,
  mcpPresetTransportSupported,
  mcpPresetVerificationSummary,
  mcpQualifiedName,
  mcpRegistryLabel,
  mcpServerEndpoint,
  mcpServerHealthLine,
  mcpServerPolicyBlock,
  mcpServerTargetLine,
  mcpServerTransportKind,
  mcpTransportLabel,
  ownedMcpName,
  parseDelimitedList,
  parseEnvLines,
  parseEnvLinesStrict,
  parseMcpJsonSnippet,
  serverFromPreset,
} from './mcp-utils'

export function McpManagementPanel({
  presets,
  servers,
  policy,
  policyLoading,
  loading,
  error,
  onRefresh,
  onCreateServer,
  onEnsurePresetServer,
  onUpdateServer,
  onDeleteServer,
  onProbeServer,
}: {
  presets: McpPreset[]
  servers: NativeMcpServerConfig[]
  policy: McpExecutionPolicy | null
  policyLoading: boolean
  loading: boolean
  error: string | null
  onRefresh: () => void
  onCreateServer: (draft: NativeMcpServerConfigDraft) => Promise<NativeMcpServerConfig | null>
  onEnsurePresetServer: (presetId: string, env?: Record<string, string>) => Promise<NativeMcpServerConfig | null>
  onUpdateServer: (id: string, patch: NativeMcpServerConfigPatch) => Promise<NativeMcpServerConfig | null>
  onDeleteServer: (id: string) => Promise<boolean>
  onProbeServer: (id: string) => Promise<McpProbeResult | null>
}) {
  const [checks, setChecks] = useState<Record<string, McpCheckState>>({})
  const [addingCustom, setAddingCustom] = useState(false)
  const [marketSearch, setMarketSearch] = useState('')
  const [installPresetId, setInstallPresetId] = useState<string | null>(null)
  const effectivePolicy = mcpEffectivePolicy(policy)
  const configuredByPreset = new Map(servers.filter((server) => server.preset_id).map((server) => [server.preset_id, server]))
  const presetById = new Map(presets.map((preset) => [preset.id, preset]))
  const officialCount = presets.filter((preset) => preset.registry === 'official').length
  const externalCount = presets.length - officialCount
  const filteredPresets = presets.filter((preset) => mcpMarketMatches(preset, marketSearch))

  const runServerProbe = async (key: string, server: NativeMcpServerConfig) => {
    const policyBlock = mcpServerPolicyBlock(server, effectivePolicy)
    if (policyBlock) {
      setChecks((prev) => ({
        ...prev,
        [key]: { ...prev[key], busy: null, error: policyBlock },
      }))
      return
    }
    setChecks((prev) => ({
      ...prev,
      [key]: { ...prev[key], busy: 'probe', error: undefined },
    }))
    const probe = await onProbeServer(server.id)
    if (probe) {
      setChecks((prev) => ({
        ...prev,
        [key]: { ...prev[key], busy: null, probe, error: undefined },
      }))
    } else {
      setChecks((prev) => ({
        ...prev,
        [key]: { ...prev[key], busy: null, error: 'MCP 连通性检查失败，请检查配置' },
      }))
    }
  }

  const runGoldenTest = async (key: string, preset: McpPreset, server?: NativeMcpServerConfig) => {
    const policyBlock = server
      ? mcpServerPolicyBlock(server, effectivePolicy)
      : mcpPresetPolicyBlock(preset, effectivePolicy)
    if (policyBlock) {
      setChecks((prev) => ({
        ...prev,
        [key]: { ...prev[key], busy: null, error: policyBlock },
      }))
      return
    }
    setChecks((prev) => ({
      ...prev,
      [key]: { ...prev[key], busy: 'golden', error: undefined },
    }))
    try {
      const golden = server
        ? await nativeAgentApi.mcp.goldenTestServer(server.id)
        : await nativeAgentApi.mcp.goldenTest({ preset_id: preset.id, server: serverFromPreset(preset) })
      setChecks((prev) => ({
        ...prev,
        [key]: { ...prev[key], busy: null, golden, error: undefined },
      }))
    } catch (err) {
      setChecks((prev) => ({
        ...prev,
        [key]: { ...prev[key], busy: null, error: errorMessage(err) },
      }))
    }
  }

  return (
    <section className="mcp-management-panel">
      <div className="tab-header-row">
        <span>
          MCP：{presets.length} 个市场条目 · {servers.length} 个拥有 · 官方 {officialCount} · 外部 {externalCount}
          {policyLoading ? ' · 策略读取中' : ''}
        </span>
        <button className="small-btn" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 刷新
        </button>
      </div>
      <div className="mcp-policy-bar">
        <span className={`mcp-chip ${effectivePolicy.remote_enabled ? 'ok' : 'warn'}`}>
          Remote Endpoint {effectivePolicy.remote_enabled ? '可用' : '不可用'}
        </span>
        <span className={`mcp-chip ${effectivePolicy.stdio_enabled ? 'ok' : 'warn'}`}>
          Local Trusted stdio {effectivePolicy.stdio_enabled ? '可用' : '不可用'}
        </span>
        {!effectivePolicy.remote_private_networks_enabled && (
          <span className="mcp-chip subtle">Remote 禁止 localhost/private endpoint</span>
        )}
      </div>
      {error && <div className="tab-error">{error}</div>}

      <section className="mcp-library-section">
        <div className="skill-market-header">
          <div>
            <strong>拥有的 MCP</strong>
            <span>这里配置已添加的官方、外部和自定义 MCP；Agent 面板只负责勾选使用。</span>
          </div>
          <button className="ghost-btn small" type="button" onClick={() => setAddingCustom((value) => !value)}>
            <Plus size={12} /> 自定义 MCP
          </button>
        </div>
        {addingCustom && (
          <CustomMcpForm
            policy={effectivePolicy}
            onCancel={() => setAddingCustom(false)}
            onSave={async (draft) => {
              const created = await onCreateServer(draft)
              if (created) setAddingCustom(false)
              return created
            }}
          />
        )}
        {servers.length === 0 ? (
          <div className="agent-empty-inline">还没有拥有的 MCP。可以从 MCP 市场添加，也可以在这里添加自定义 MCP。</div>
        ) : (
          <div className="mcp-catalog-list">
            {servers.map((server) => {
              const key = `server:${server.id}`
              const check = checks[key]
              const preset = server.preset_id ? presetById.get(server.preset_id) : undefined
              return (
                <McpOwnedServerRow
                  key={server.id}
                  server={server}
                  preset={preset}
                  check={check}
                  policy={effectivePolicy}
                  onUpdate={onUpdateServer}
                  onDelete={onDeleteServer}
                  onProbe={() => runServerProbe(key, server)}
                  onGolden={preset ? () => runGoldenTest(key, preset, server) : undefined}
                />
              )
            })}
          </div>
        )}
      </section>

      <section className="mcp-library-section">
        <div className="skill-market-header">
          <div>
            <strong>MCP 市场</strong>
            <span>官方和外部 MCP 统一陈列；名称采用 所有者@MCP名。</span>
          </div>
        </div>
        <label className="skill-market-search">
          <span>搜索 MCP 市场</span>
          <input
            value={marketSearch}
            onChange={(event) => setMarketSearch(event.target.value)}
            placeholder="搜索所有者、MCP 名、描述、分类、能力"
          />
        </label>
        {presets.length === 0 ? (
          <div className="agent-empty-inline">还没有读取到 MCP 市场条目。</div>
        ) : filteredPresets.length === 0 ? (
          <div className="agent-empty-inline">没有匹配「{marketSearch.trim()}」的 MCP。</div>
        ) : (
          <div className="mcp-catalog-list">
            {filteredPresets.map((preset) => {
              const configured = configuredByPreset.get(preset.id)
              const capabilities = preset.capabilities.slice(0, 4)
              const remainingCapabilities = Math.max(0, preset.capabilities.length - capabilities.length)
              const sourceUrl = mcpPresetSourceUrl(preset)
              const transportSupported = mcpPresetTransportSupported(preset, effectivePolicy)
              return (
                <div key={preset.id} className="mcp-market-entry">
                  <div className="mcp-catalog-row">
                    <div className="skill-market-copy mcp-market-copy">
                      <strong>{mcpQualifiedName(preset)}</strong>
                      <span>{preset.description}</span>
                      <small>{mcpRegistryLabel(preset)} · {preset.category} · {mcpPresetSourceLabel(preset)}</small>
                      <div className="mcp-market-chips" aria-label="MCP preset metadata">
                        <span className={`mcp-chip ${transportSupported ? 'ok' : 'warn'}`}>
                          {mcpPresetTransportLabel(preset)}
                          {transportSupported ? '' : ' 暂不支持运行'}
                        </span>
                        <span className="mcp-chip">{mcpPresetEnvSummary(preset)}</span>
                        <span className="mcp-chip">验证: {mcpPresetVerificationSummary(preset)}</span>
                        {capabilities.map((capability) => (
                          <span key={capability} className="mcp-chip subtle">{capability}</span>
                        ))}
                        {remainingCapabilities > 0 && <span className="mcp-chip subtle">+{remainingCapabilities}</span>}
                      </div>
                    </div>
                    <div className="mcp-row-actions">
                      {isOfficialRecommendedMcp(preset) && <OfficialMcpBadge />}
                      {sourceUrl && (
                        <a className="ghost-btn small" href={sourceUrl} target="_blank" rel="noreferrer">
                          文档
                        </a>
                      )}
                      {configured ? (
                        <span className="native-pill neutral">已添加</span>
                      ) : (
                        <button
                          className="ghost-btn small"
                          type="button"
                          onClick={() => setInstallPresetId((current) => (current === preset.id ? null : preset.id))}
                        >
                          <Plus size={12} /> {installPresetId === preset.id ? '收起' : '添加 MCP'}
                        </button>
                      )}
                    </div>
                  </div>
                  {!configured && installPresetId === preset.id && (
                    <McpPresetInstallPanel
                      preset={preset}
                      policy={effectivePolicy}
                      onCancel={() => setInstallPresetId(null)}
                      onInstall={async (env) => {
                        const created = await onEnsurePresetServer(preset.id, env)
                        if (created) setInstallPresetId(null)
                        return created
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </section>
  )
}

function McpPresetInstallPanel({
  preset,
  policy,
  onInstall,
  onCancel,
}: {
  preset: McpPreset
  policy: McpExecutionPolicy
  onInstall: (env?: Record<string, string>) => Promise<NativeMcpServerConfig | null>
  onCancel: () => void
}) {
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = mcpPresetTransportSupported(preset, policy)
  const policyBlock = mcpPresetPolicyBlock(preset, policy)
  const tools = mcpPresetAllowedTools(preset)

  useEffect(() => {
    setEnvDraft(Object.fromEntries(preset.env_schema.map((field) => [field.name, ''])))
    setError(null)
  }, [preset.id, preset.env_schema])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!supported) {
      setError(policyBlock || '当前部署策略不允许运行这个 MCP transport。')
      return
    }
    const env = Object.fromEntries(
      Object.entries(envDraft)
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value),
    )
    setSaving(true)
    const created = await onInstall(Object.keys(env).length ? env : undefined)
    setSaving(false)
    if (!created) setError('添加 MCP 失败，请稍后重试或检查 preset 配置。')
  }

  return (
    <form className="mcp-install-panel" onSubmit={submit}>
      <div className="mcp-install-head">
        <div>
          <strong>确认添加 {mcpQualifiedName(preset)}</strong>
          <span>{preset.description}</span>
        </div>
        <span className={`mcp-chip ${supported ? 'ok' : 'warn'}`}>
          {mcpPresetTransportLabel(preset)}
          {supported ? ' 可运行' : ' 暂不支持运行'}
        </span>
      </div>

      <div className="mcp-install-detail">
        <span>{mcpPresetTransportKind(preset) === 'remote' ? 'Endpoint' : 'Command'}</span>
        <code>{mcpPresetTargetLine(preset)}</code>
      </div>
      {mcpPresetTransportKind(preset) === 'stdio' && (
        <div className="mcp-install-detail">
          <span>Args</span>
          <code>{preset.transport.args?.length ? preset.transport.args.join(' ') : '(none)'}</code>
        </div>
      )}
      <div className="mcp-install-detail">
        <span>Allowed tools</span>
        <code>{tools.length ? tools.join(', ') : '全部工具'}</code>
      </div>
      <div className="mcp-install-detail">
        <span>Verification</span>
        <code>{mcpPresetVerificationSummary(preset)}</code>
      </div>

      {preset.env_schema.length > 0 ? (
        <div className="mcp-env-fields">
          {preset.env_schema.map((field) => (
            <label key={field.name}>
              <span>
                {field.label || field.name}
                {field.required ? ' · 必填' : field.required_for_reliable_use ? ' · 推荐' : ''}
              </span>
              <input
                type={field.secret ? 'password' : 'text'}
                value={envDraft[field.name] ?? ''}
                onChange={(event) => setEnvDraft((prev) => ({ ...prev, [field.name]: event.target.value }))}
                placeholder={field.name}
                autoComplete="off"
              />
              {field.description && <small>{field.description}</small>}
            </label>
          ))}
        </div>
      ) : (
        <div className="mcp-check-result ok">这个 preset 不需要环境变量。</div>
      )}

      {!supported && (
        <div className="mcp-check-result warn">{policyBlock || '当前部署策略不允许运行这个 MCP transport。'}</div>
      )}
      {error && <div className="mcp-check-result error">{error}</div>}
      <div className="mcp-install-actions">
        <button type="button" className="ghost-btn small" onClick={onCancel} disabled={saving}>取消</button>
        <button type="submit" className="primary-btn compact" disabled={saving || !supported}>
          {saving ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
          确认添加
        </button>
      </div>
    </form>
  )
}

function McpOwnedServerRow({
  server,
  preset,
  check,
  policy,
  onUpdate,
  onDelete,
  onProbe,
  onGolden,
}: {
  server: NativeMcpServerConfig
  preset?: McpPreset
  check?: McpCheckState
  policy: McpExecutionPolicy
  onUpdate: (id: string, patch: NativeMcpServerConfigPatch) => Promise<NativeMcpServerConfig | null>
  onDelete: (id: string) => Promise<boolean>
  onProbe: () => Promise<void>
  onGolden?: () => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const connectivityOk = mcpConnectivityOk(server, check)
  const functionalityOk = mcpFunctionalityOk(server, check)
  const healthLine = mcpServerHealthLine(server, check)
  const policyBlock = mcpServerPolicyBlock(server, policy)
  const transportLabel = mcpTransportLabel(server.transport)

  return (
    <div className={`mcp-catalog-row ${expanded ? 'expanded' : ''} ${policyBlock ? 'policy-blocked' : ''}`}>
      <div className="skill-market-copy">
        <strong>{ownedMcpName(server, preset)}</strong>
        <span>
          {preset ? mcpRegistryLabel(preset) : '自定义'} · {transportLabel} · {server.is_enabled ? '已启用' : '已停用'} · {server.env_keys.length ? `Env: ${server.env_keys.join(', ')}` : '无 Env'}
        </span>
        <small>{mcpServerTargetLine(server)}</small>
        {policyBlock && <small className="mcp-health-line warning">{policyBlock}</small>}
        {healthLine && <small className="mcp-health-line">{healthLine}</small>}
      </div>
      <div className="mcp-row-actions">
        {isOfficialRecommendedMcp(preset) && <OfficialMcpBadge />}
        <button
          className={`ghost-btn small ${connectivityOk ? 'success' : ''}`}
          type="button"
          disabled={Boolean(check?.busy) || !server.is_enabled || Boolean(policyBlock)}
          onClick={() => void onProbe()}
        >
          {check?.busy === 'probe' ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          连通性
        </button>
        {onGolden && (
          <button
            className={`ghost-btn small ${functionalityOk ? 'success' : ''}`}
            type="button"
            onClick={() => void onGolden()}
            disabled={Boolean(check?.busy) || Boolean(policyBlock)}
          >
            {check?.busy === 'golden' ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={12} />}
            功能性
          </button>
        )}
        <button className="ghost-btn small" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起配置' : '配置'}
        </button>
      </div>
      {expanded && (
        <McpServerEditor
          server={server}
          preset={preset}
          check={check}
          policy={policy}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onProbe={onProbe}
          onGolden={onGolden}
          onSaved={() => setExpanded(false)}
        />
      )}
      <McpCheckResult check={check} />
    </div>
  )
}

function McpServerEditor({
  server,
  preset,
  check,
  policy,
  onUpdate,
  onDelete,
  onProbe,
  onGolden,
  onSaved,
}: {
  server: NativeMcpServerConfig
  preset?: McpPreset
  check?: McpCheckState
  policy: McpExecutionPolicy
  onUpdate: (id: string, patch: NativeMcpServerConfigPatch) => Promise<NativeMcpServerConfig | null>
  onDelete: (id: string) => Promise<boolean>
  onProbe: () => Promise<void>
  onGolden?: () => Promise<void>
  onSaved?: () => void
}) {
  const isRemote = mcpServerTransportKind(server) === 'remote'
  const policyBlock = mcpServerPolicyBlock(server, policy)
  const [draft, setDraft] = useState({
    name: ownedMcpName(server, preset),
    description: server.description,
    endpoint: mcpServerEndpoint(server),
    command: server.command,
    args: joinArgs(server.args),
    allowedTools: server.allowed_tools.join(', '),
    envText: '',
    isEnabled: server.is_enabled,
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft({
      name: ownedMcpName(server, preset),
      description: server.description,
      endpoint: mcpServerEndpoint(server),
      command: server.command,
      args: joinArgs(server.args),
      allowedTools: server.allowed_tools.join(', '),
      envText: '',
      isEnabled: server.is_enabled,
    })
  }, [server.id, server.updated_at, preset?.qualified_name, preset?.name, preset?.owner])

  const save = async () => {
    setSaving(true)
    const patch: NativeMcpServerConfigPatch = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      transport: isRemote ? 'remote' : 'stdio',
      allowed_tools: draft.allowedTools.split(',').map((item) => item.trim()).filter(Boolean),
      is_enabled: draft.isEnabled,
    }
    if (isRemote) {
      patch.endpoint = draft.endpoint.trim()
    } else {
      patch.command = draft.command.trim()
      patch.args = splitArgs(draft.args)
    }
    if (draft.envText.trim()) patch.env = parseEnvLines(draft.envText)
    const updated = await onUpdate(server.id, patch)
    if (updated) {
      setDraft((prev) => ({ ...prev, envText: '' }))
      onSaved?.()
    }
    setSaving(false)
  }

  return (
    <div className="mcp-server-grid mcp-config-editor">
      <label>
        <span>Name（owner@MCP）</span>
        <input value={draft.name} onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))} />
      </label>
      <label>
        <span>{isRemote ? 'Endpoint' : 'Command'}</span>
        <input
          value={isRemote ? draft.endpoint : draft.command}
          onChange={(event) => {
            const value = event.target.value
            setDraft((prev) => (isRemote ? { ...prev, endpoint: value } : { ...prev, command: value }))
          }}
          disabled={!isRemote && Boolean(policyBlock)}
        />
      </label>
      {!isRemote && (
        <label>
          <span>Args</span>
          <input
            value={draft.args}
            onChange={(event) => setDraft((prev) => ({ ...prev, args: event.target.value }))}
            disabled={Boolean(policyBlock)}
          />
        </label>
      )}
      <label>
        <span>Allowed tools</span>
        <input
          value={draft.allowedTools}
          onChange={(event) => setDraft((prev) => ({ ...prev, allowedTools: event.target.value }))}
          placeholder="留空表示暴露全部工具"
        />
      </label>
      <label>
        <span>Description</span>
        <input value={draft.description} onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))} />
      </label>
      <label>
        <span>Env 更新</span>
        <textarea
          rows={3}
          value={draft.envText}
          onChange={(event) => setDraft((prev) => ({ ...prev, envText: event.target.value }))}
          placeholder={server.env_keys.length ? `已保存：${server.env_keys.join(', ')}` : envPlaceholderForPreset(preset)}
        />
        <small>仅填写要保存或覆盖的 KEY=value；密钥不会回显。</small>
      </label>
      <div className="mcp-card-actions mcp-editor-actions">
        <label className="agent-export-toggle">
          <input
            type="checkbox"
            checked={draft.isEnabled}
            onChange={(event) => setDraft((prev) => ({ ...prev, isEnabled: event.target.checked }))}
          />
          启用
        </label>
        <button type="button" className="ghost-btn small" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={12} />}
          保存配置
        </button>
        <button
          type="button"
          className={`ghost-btn small ${mcpConnectivityOk(server, check) ? 'success' : ''}`}
          onClick={() => void onProbe()}
          disabled={Boolean(check?.busy) || !server.is_enabled || Boolean(policyBlock)}
        >
          <RefreshCw size={12} /> 连通性
        </button>
        {onGolden && (
          <button
            type="button"
            className={`ghost-btn small ${mcpFunctionalityOk(server, check) ? 'success' : ''}`}
            onClick={() => void onGolden()}
            disabled={Boolean(check?.busy) || Boolean(policyBlock)}
          >
            <CheckCircle2 size={12} /> 功能性
          </button>
        )}
        <button type="button" className="ghost-btn small danger" onClick={() => void onDelete(server.id)}>
          <Trash2 size={12} /> 删除配置
        </button>
      </div>
    </div>
  )
}

function CustomMcpForm({
  policy,
  onSave,
  onCancel,
}: {
  policy: McpExecutionPolicy
  onSave: (draft: NativeMcpServerConfigDraft) => Promise<NativeMcpServerConfig | null>
  onCancel: () => void
}) {
  const [activeTab, setActiveTab] = useState<McpCustomTab>('remote')
  const [remoteDraft, setRemoteDraft] = useState({
    owner: 'remote',
    mcpName: '',
    description: '',
    endpoint: '',
    authToken: '',
    allowedTools: '',
    envText: '',
  })
  const [stdioDraft, setStdioDraft] = useState({
    owner: 'local',
    mcpName: '',
    description: '',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-everything',
    allowedTools: '',
    envText: '',
  })
  const [jsonText, setJsonText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const localTrustedAvailable = policy.stdio_enabled

  const applyJsonPaste = () => {
    setError(null)
    const result = parseMcpJsonSnippet(jsonText)
    if (result.error || !result.parsed) {
      setError(result.error || '无法读取 MCP JSON')
      return
    }
    const { parsed } = result
    const [ownerFromId, nameFromId] = parsed.id.includes('@')
      ? parsed.id.split('@', 2)
      : ['', parsed.id]
    setStdioDraft((prev) => ({
      ...prev,
      owner: ownerFromId || prev.owner || 'local',
      mcpName: nameFromId || parsed.name || prev.mcpName,
      description: parsed.description || prev.description,
      command: parsed.command,
      args: joinArgs(parsed.args),
      allowedTools: parsed.allowedTools.join(', '),
      envText: Object.entries(parsed.env).map(([key, value]) => `${key}=${value}`).join('\n'),
    }))
  }

  const submitRemote = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!policy.remote_enabled) {
      setError('当前部署未开启 Remote MCP endpoint。')
      return
    }
    const endpoint = remoteDraft.endpoint.trim()
    if (!endpoint) {
      setError('Remote endpoint 不能为空')
      return
    }
    if (!/^https?:\/\//i.test(endpoint)) {
      setError('Remote endpoint 需要使用 http:// 或 https://')
      return
    }
    const envResult = parseEnvLinesStrict(remoteDraft.envText)
    if (envResult.error) {
      setError(envResult.error)
      return
    }
    const env = { ...envResult.env }
    if (remoteDraft.authToken.trim()) env.MCP_AUTH_TOKEN = remoteDraft.authToken.trim()
    const owner = remoteDraft.owner.trim() || 'remote'
    const mcpName = remoteDraft.mcpName.trim() || mcpNameFromEndpoint(endpoint)
    setSaving(true)
    const created = await onSave({
      source: 'custom',
      name: `${owner}@${mcpName}`,
      description: remoteDraft.description.trim(),
      transport: 'remote',
      endpoint,
      env,
      allowed_tools: parseDelimitedList(remoteDraft.allowedTools),
      is_enabled: true,
    })
    setSaving(false)
    if (!created) setError('创建 Remote MCP 配置失败')
  }

  const submitStdio = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!localTrustedAvailable) {
      setError('当前部署未开启 Local Trusted MCP（YLW_MCP_STDIO_ENABLED=false）')
      return
    }
    if (!stdioDraft.command.trim()) {
      setError('Command 不能为空')
      return
    }
    const envResult = parseEnvLinesStrict(stdioDraft.envText)
    if (envResult.error) {
      setError(envResult.error)
      return
    }
    const owner = stdioDraft.owner.trim() || 'local'
    const mcpName = stdioDraft.mcpName.trim() || stdioDraft.command.trim()
    setSaving(true)
    const created = await onSave({
      source: 'custom',
      name: `${owner}@${mcpName}`,
      description: stdioDraft.description.trim(),
      transport: 'stdio',
      command: stdioDraft.command.trim(),
      args: splitArgs(stdioDraft.args),
      env: envResult.env,
      allowed_tools: parseDelimitedList(stdioDraft.allowedTools),
      is_enabled: true,
    })
    setSaving(false)
    if (!created) setError('创建 Local Trusted MCP 配置失败')
  }

  return (
    <div className="native-agent-inline-form mcp-custom-form">
      <div className="mcp-custom-tabs" role="tablist" aria-label="自定义 MCP 类型">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'remote'}
          className={activeTab === 'remote' ? 'active' : ''}
          onClick={() => {
            setActiveTab('remote')
            setError(null)
          }}
        >
          Remote Endpoint
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'stdio'}
          className={activeTab === 'stdio' ? 'active' : ''}
          disabled={!localTrustedAvailable}
          title={localTrustedAvailable ? 'Local Trusted stdio' : '当前部署未开启 Local Trusted MCP'}
          onClick={() => {
            setActiveTab('stdio')
            setError(null)
          }}
        >
          Local Trusted stdio
        </button>
      </div>
      {!localTrustedAvailable && (
        <div className="mcp-check-result warn">Local Trusted stdio 当前不可用：YLW_MCP_STDIO_ENABLED=false。</div>
      )}
      {activeTab === 'remote' ? (
        <form className="mcp-custom-tab-panel" onSubmit={submitRemote}>
          <div className="mcp-server-grid">
            <label>
              <span>Owner</span>
              <input value={remoteDraft.owner} onChange={(event) => setRemoteDraft((prev) => ({ ...prev, owner: event.target.value }))} placeholder="remote" />
            </label>
            <label>
              <span>MCP 名称</span>
              <input value={remoteDraft.mcpName} onChange={(event) => setRemoteDraft((prev) => ({ ...prev, mcpName: event.target.value }))} placeholder="context7" />
            </label>
            <label>
              <span>Endpoint</span>
              <input
                value={remoteDraft.endpoint}
                onChange={(event) => setRemoteDraft((prev) => ({ ...prev, endpoint: event.target.value }))}
                placeholder="https://mcp.example.com/rpc"
              />
              {!policy.remote_private_networks_enabled && <small>localhost/private endpoint 会被后端拒绝。</small>}
            </label>
            <label>
              <span>Auth token</span>
              <input
                type="password"
                value={remoteDraft.authToken}
                onChange={(event) => setRemoteDraft((prev) => ({ ...prev, authToken: event.target.value }))}
                placeholder="可选；保存为 MCP_AUTH_TOKEN"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Allowed tools</span>
              <input
                value={remoteDraft.allowedTools}
                onChange={(event) => setRemoteDraft((prev) => ({ ...prev, allowedTools: event.target.value }))}
                placeholder="tool_a, tool_b"
              />
            </label>
            <label>
              <span>Description</span>
              <input value={remoteDraft.description} onChange={(event) => setRemoteDraft((prev) => ({ ...prev, description: event.target.value }))} />
            </label>
            <label>
              <span>Env</span>
              <textarea rows={3} value={remoteDraft.envText} onChange={(event) => setRemoteDraft((prev) => ({ ...prev, envText: event.target.value }))} placeholder="KEY=value" />
            </label>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button type="button" className="ghost-btn" onClick={onCancel} disabled={saving}>取消</button>
            <button type="submit" className="primary-btn" disabled={saving || !policy.remote_enabled}>
              {saving ? <Loader2 size={14} className="spin" /> : '添加 Remote MCP'}
            </button>
          </div>
        </form>
      ) : (
        <form className="mcp-custom-tab-panel" onSubmit={submitStdio}>
          <div className="mcp-server-grid">
            <label>
              <span>Owner</span>
              <input value={stdioDraft.owner} onChange={(event) => setStdioDraft((prev) => ({ ...prev, owner: event.target.value }))} placeholder="local" />
            </label>
            <label>
              <span>MCP 名称</span>
              <input value={stdioDraft.mcpName} onChange={(event) => setStdioDraft((prev) => ({ ...prev, mcpName: event.target.value }))} placeholder="context7" />
            </label>
            <label>
              <span>Command</span>
              <input value={stdioDraft.command} onChange={(event) => setStdioDraft((prev) => ({ ...prev, command: event.target.value }))} />
            </label>
            <label>
              <span>Args</span>
              <input value={stdioDraft.args} onChange={(event) => setStdioDraft((prev) => ({ ...prev, args: event.target.value }))} />
            </label>
            <label>
              <span>Allowed tools</span>
              <input
                value={stdioDraft.allowedTools}
                onChange={(event) => setStdioDraft((prev) => ({ ...prev, allowedTools: event.target.value }))}
                placeholder="tool_a, tool_b"
              />
            </label>
            <label>
              <span>Description</span>
              <input value={stdioDraft.description} onChange={(event) => setStdioDraft((prev) => ({ ...prev, description: event.target.value }))} />
            </label>
            <label>
              <span>Env</span>
              <textarea rows={3} value={stdioDraft.envText} onChange={(event) => setStdioDraft((prev) => ({ ...prev, envText: event.target.value }))} placeholder="KEY=value" />
            </label>
          </div>
          <div className="mcp-json-paste">
            <label>
              <span>粘贴 stdio MCP JSON</span>
              <textarea
                rows={4}
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
                placeholder='{ "mcpServers": { "paper-search": { "command": "npx", "args": ["-y", "..."], "env": {} } } }'
              />
            </label>
            <button type="button" className="ghost-btn small" onClick={applyJsonPaste} disabled={!jsonText.trim() || saving}>
              填充表单
            </button>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button type="button" className="ghost-btn" onClick={onCancel} disabled={saving}>取消</button>
            <button type="submit" className="primary-btn" disabled={saving || !localTrustedAvailable}>
              {saving ? <Loader2 size={14} className="spin" /> : '添加 Local Trusted MCP'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function McpCheckResult({ check }: { check?: McpCheckState }) {
  if (!check || check.busy) return null
  if (check.error) {
    return <div className="mcp-check-result error">{check.error}</div>
  }
  if (check.golden) {
    const detail = check.golden.error
      ? ` · ${check.golden.error}`
      : check.golden.warnings && check.golden.warnings.length > 0
        ? ` · ${check.golden.warnings.join('; ')}`
        : ''
    return (
      <div className={`mcp-check-result ${check.golden.passed ? 'ok' : 'error'}`}>
        功能性检查{check.golden.passed ? '通过' : '失败'}
        {detail}
      </div>
    )
  }
  if (check.probe) {
    const warning = check.probe.warnings.length > 0 ? ` · ${check.probe.warnings.join('; ')}` : ''
    const missing = check.probe.missing_tools.length > 0 ? ` · missing: ${check.probe.missing_tools.join(', ')}` : ''
    return (
      <div className={`mcp-check-result ${check.probe.status === 'ok' ? 'ok' : 'warn'}`}>
        连通性 {check.probe.status} · {check.probe.tools.length} tools{missing}{warning}
      </div>
    )
  }
  return null
}

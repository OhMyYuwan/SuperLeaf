/**
 * Provider-level components: the per-provider Agent block, the local-agent MCP
 * status / Nanobot tool-adapter status badges, the backend status bar, and the
 * new-provider creation form.
 */

import { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type {
  CachedWorkflow,
  Provider,
  ProviderModel,
  ProviderUpdate,
} from '../../../services/backendApi'
import { BACKEND_BASE, providerApi } from '../../../services/backendApi'
import {
  DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT,
  discoverBrowserNanobotAgents,
  nanobotLocalAgentHostEndpointFromRaw,
  readBrowserNanobotApiKey,
} from '../../../services/nanobotBrowserClient'
import { listBrowserCodexModels, probeBrowserCodex } from '../../../services/codexBrowserClient'
import { probeBrowserClaude } from '../../../services/claudeBrowserClient'
import { statsApi, type AgentStat } from '../../../services/statsApi'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useNativeAgentStore } from '../../../stores/nativeAgentStore'
import {
  booleanRecordValue,
  enumMeta,
  numberRecordValue,
  objectMeta,
  stringArray,
  stringRecordValue,
} from './meta'
import { compactEndpointLabel } from './format'
import {
  ClaudeSettingsFields,
  CodexSettingsFields,
  claudeProviderSettings,
  claudeSettingsPatch,
  codexProviderSettings,
  codexSettingsPatch,
  localAgentWorkspacePath,
} from './provider-settings'
import {
  localAgentName,
  modelsFromProviderMeta,
  providerConsoleLabel,
  realCodexModelOptions,
} from './agent-presentation'
import { AgentCard, NativeAgentCard } from './agent-cards'
import { NativeAgentForm } from './NativeAgentForm'

interface ProviderBlockProps {
  provider: Provider
  workflows: CachedWorkflow[]
  workflowsLoaded: boolean
  onChatWithAgent?: (workflow: CachedWorkflow) => void
  onAfterMutate: () => void
}

export function ProviderBlock({
  provider,
  workflows,
  workflowsLoaded,
  onChatWithAgent,
  onAfterMutate,
}: ProviderBlockProps) {
  const probe = useSettingsStore((s) => s.probe)
  const updateProvider = useSettingsStore((s) => s.update)
  const remove = useSettingsStore((s) => s.remove)
  const activate = useSettingsStore((s) => s.activate)
  const loadProviders = useSettingsStore((s) => s.load)
  const nativeAgents = useNativeAgentStore((s) => s.agents)
  const nativeSkills = useNativeAgentStore((s) => s.skills)
  const nativeLoaded = useNativeAgentStore((s) => s.loaded)
  const nativeError = useNativeAgentStore((s) => s.error)
  const loadNativeAgents = useNativeAgentStore((s) => s.loadAll)
  const createNativeAgent = useNativeAgentStore((s) => s.createAgent)
  const updateNativeAgent = useNativeAgentStore((s) => s.updateAgent)
  const removeNativeAgent = useNativeAgentStore((s) => s.removeAgent)
  const [busy, setBusy] = useState<'probe' | 'remove' | 'activate' | null>(null)
  const [statsByWorkflow, setStatsByWorkflow] = useState<Record<string, AgentStat>>({})
  const [editingProvider, setEditingProvider] = useState(false)
  const [providerPatch, setProviderPatch] = useState<ProviderUpdate>({
    name: provider.name,
    endpoint: provider.endpoint,
    api_key: '',
    workspace_path: localAgentWorkspacePath(provider),
    ...codexProviderSettings(provider),
    ...claudeProviderSettings(provider),
  })
  const [providerError, setProviderError] = useState<string | null>(null)
  const [showNativeForm, setShowNativeForm] = useState(false)
  const [modelOptions, setModelOptions] = useState<ProviderModel[]>([])
  const [modelError, setModelError] = useState<string | null>(null)

  const providerNativeAgents = nativeAgents.filter((agent) => agent.provider_id === provider.id)

  useEffect(() => {
    setProviderPatch({
      name: provider.name,
      endpoint: provider.endpoint,
      api_key: '',
      workspace_path: localAgentWorkspacePath(provider),
      ...codexProviderSettings(provider),
      ...claudeProviderSettings(provider),
    })
  }, [provider.id, provider.name, provider.endpoint, provider.meta])

  useEffect(() => {
    if (provider.kind === 'native' && !nativeLoaded) void loadNativeAgents()
  }, [provider.kind, nativeLoaded, loadNativeAgents])

  useEffect(() => {
    if (provider.kind === 'codex-local') {
      setModelOptions(realCodexModelOptions(modelsFromProviderMeta(provider.meta)))
      setModelError(null)
      let cancelled = false
      listBrowserCodexModels(provider.endpoint)
        .then((models) => {
          if (cancelled) return
          setModelOptions(realCodexModelOptions(models))
          setModelError(null)
        })
        .catch(() => {
          // Keep cached/default state; explicit refresh will show the error.
        })
      return () => {
        cancelled = true
      }
    }
    if (provider.kind === 'native') {
      setModelOptions(modelsFromProviderMeta(provider.meta))
      setModelError(null)
    } else {
      setModelOptions([])
      setModelError(null)
    }
  }, [provider.kind, provider.meta])

  // Fetch per-agent stats whenever the workflow set under this provider
  // changes. Failures are non-fatal: cards just render without stats.
  useEffect(() => {
    if (!workflowsLoaded) return
    let cancelled = false
    statsApi
      .forProvider(provider.id)
      .then((resp) => {
        if (cancelled) return
        const map: Record<string, AgentStat> = {}
        for (const a of resp.agents) map[a.workflow_id] = a
        setStatsByWorkflow(map)
      })
      .catch(() => {
        // Provider down / unauthorized — silently leave stats empty.
      })
    return () => {
      cancelled = true
    }
  }, [provider.id, workflowsLoaded, workflows.length])

  const handleProbe = async () => {
    setBusy('probe')
    if (provider.kind === 'codex-local') {
      try {
        const health = await probeBrowserCodex(provider.endpoint)
        let models: ProviderModel[] = []
        try {
          models = await listBrowserCodexModels(provider.endpoint)
          setModelOptions(realCodexModelOptions(models))
          setModelError(null)
        } catch (err) {
          setModelOptions([])
          setModelError(err instanceof Error ? err.message : '无法读取本机 Codex 模型列表')
        }
        await providerApi.syncBrowserCodexAgent(provider.id, { health, models })
        await loadProviders()
      } catch (err) {
        setProviderError(err instanceof Error ? err.message : '浏览器无法访问本机 Codex')
      } finally {
        setBusy(null)
        onAfterMutate()
      }
      return
    }
    if (provider.kind === 'claude-local') {
      try {
        const health = await probeBrowserClaude(provider.endpoint)
        await providerApi.syncBrowserClaudeAgent(provider.id, { health })
        await loadProviders()
      } catch (err) {
        setProviderError(err instanceof Error ? err.message : '浏览器无法访问本机 Claude')
      } finally {
        setBusy(null)
        onAfterMutate()
      }
      return
    }
    const updated = await probe(provider.id)
    if (updated?.kind === 'native') {
      setModelOptions(modelsFromProviderMeta(updated.meta))
      setModelError(null)
    }
    setBusy(null)
    onAfterMutate()
  }
  const handleRemove = async () => {
    if (!confirm(`删除 Agent「${provider.name}」？该 Agent 的历史运行记录会保留。`)) return
    setBusy('remove')
    await remove(provider.id)
    setBusy(null)
    onAfterMutate()
  }
  const handleActivate = async () => {
    setBusy('activate')
    await activate(provider.id)
    setBusy(null)
  }
  const handleProviderUpdate = async (event: React.FormEvent) => {
    event.preventDefault()
    setProviderError(null)
    const patch: ProviderUpdate = {
      name: providerPatch.name?.trim(),
      endpoint: providerPatch.endpoint?.trim(),
    }
    if (providerPatch.api_key?.trim()) patch.api_key = providerPatch.api_key.trim()
    if (!patch.name || !patch.endpoint) {
      setProviderError('名称和 endpoint 不能为空')
      return
    }
    if (provider.kind === 'codex-local' || provider.kind === 'claude-local') {
      patch.workspace_path = providerPatch.workspace_path?.trim() ?? ''
      if (!patch.workspace_path) {
        setProviderError(`${localAgentName(provider.kind)} 需要填写代码项目 workspace path`)
        return
      }
    }
    if (provider.kind === 'codex-local') {
      Object.assign(patch, codexSettingsPatch(providerPatch))
    }
    if (provider.kind === 'claude-local') {
      Object.assign(patch, claudeSettingsPatch(providerPatch))
    }
    const updated = await updateProvider(provider.id, patch)
    if (updated) {
      if (updated.kind === 'codex-local') {
        try {
          const health = await probeBrowserCodex(updated.endpoint)
          let models: ProviderModel[] = []
          try {
            models = await listBrowserCodexModels(updated.endpoint)
            setModelOptions(realCodexModelOptions(models))
            setModelError(null)
          } catch (err) {
            setModelOptions([])
            setModelError(err instanceof Error ? err.message : '无法读取本机 Codex 模型列表')
          }
          await providerApi.syncBrowserCodexAgent(updated.id, { health, models })
          await loadProviders()
        } catch (err) {
          setProviderError(err instanceof Error ? err.message : '浏览器无法访问本机 Codex')
          return
        }
      } else if (updated.kind === 'claude-local') {
        try {
          const health = await probeBrowserClaude(updated.endpoint)
          await providerApi.syncBrowserClaudeAgent(updated.id, { health })
          await loadProviders()
        } catch (err) {
          setProviderError(err instanceof Error ? err.message : '浏览器无法访问本机 Claude')
          return
        }
      } else {
        const synced = await probe(provider.id)
        if (synced?.kind === 'native') {
          setModelOptions(modelsFromProviderMeta(synced.meta))
        }
      }
      setEditingProvider(false)
      onAfterMutate()
    } else {
      setProviderError('保存失败')
    }
  }

  return (
    <div className={`agent-team-block ${provider.is_active ? 'active' : ''}`}>
      <div className="agent-team-block-header">
        <div className="agent-team-block-title">
          <span className="provider-name">{provider.name}</span>
          <span className={`status-chip ${provider.status}`}>
            {provider.status === 'ok' && <CheckCircle2 size={11} />}
            {provider.status === 'error' && <CircleAlert size={11} />}
            {provider.status}
          </span>
          {provider.is_active && <span className="active-chip">默认</span>}
        </div>
        <div className="agent-team-block-actions">
          <button className="ghost-btn small" onClick={handleProbe} disabled={!!busy} title="测试连接并同步">
            {busy === 'probe' ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
          </button>
          <button className="ghost-btn small" onClick={() => setEditingProvider((v) => !v)} disabled={!!busy} title="编辑 Provider">
            <Pencil size={12} />
          </button>
          {!provider.is_active && (
            <button className="ghost-btn small" onClick={handleActivate} disabled={!!busy} title="设为默认">
              ★
            </button>
          )}
          <button className="ghost-btn small danger" onClick={handleRemove} disabled={!!busy} title="删除供应商">
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="agent-team-block-meta">
        <span className="kind">{provider.kind}</span>
        <span className="endpoint" title={provider.endpoint}>{provider.endpoint}</span>
      </div>
      {provider.status_detail && provider.status === 'error' && (
        <div className="detail error">{provider.status_detail}</div>
      )}
      {(provider.kind === 'codex-local' || provider.kind === 'claude-local') && <LocalAgentMcpStatus provider={provider} />}
      {provider.kind === 'nanobot' && provider.meta?.transport === 'browser' && <NanobotToolAdapterStatus provider={provider} />}

      {editingProvider && (
        <form className="provider-edit-form" onSubmit={handleProviderUpdate}>
          <div className="form-row">
            <label>
              <span>名称</span>
              <input
                value={providerPatch.name ?? ''}
                onChange={(event) => setProviderPatch((prev) => ({ ...prev, name: event.target.value }))}
              />
            </label>
            <label>
              <span>Endpoint</span>
              <input
                value={providerPatch.endpoint ?? ''}
                onChange={(event) => setProviderPatch((prev) => ({ ...prev, endpoint: event.target.value }))}
              />
            </label>
          </div>
          <label className="full">
            <span>API Key</span>
            <input
              type="password"
              value={providerPatch.api_key ?? ''}
              onChange={(event) => setProviderPatch((prev) => ({ ...prev, api_key: event.target.value }))}
              placeholder={provider.has_api_key ? '留空表示不修改' : '请输入 API key'}
            />
          </label>
          {(provider.kind === 'codex-local' || provider.kind === 'claude-local') && (
            <>
              <label className="full">
                <span>Workspace Path</span>
                <input
                  value={providerPatch.workspace_path ?? ''}
                  onChange={(event) => setProviderPatch((prev) => ({ ...prev, workspace_path: event.target.value }))}
                  placeholder="/Users/me/code/my-paper-project"
                />
              </label>
              {provider.kind === 'codex-local' ? (
                <CodexSettingsFields
                  draft={providerPatch}
                  modelOptions={modelOptions}
                  onChange={(patch) => setProviderPatch((prev) => ({ ...prev, ...patch }))}
                />
              ) : (
                <ClaudeSettingsFields
                  draft={providerPatch}
                  onChange={(patch) => setProviderPatch((prev) => ({ ...prev, ...patch }))}
                />
              )}
            </>
          )}
          {provider.kind === 'codex-local' && modelError && <div className="form-error">{modelError}</div>}
          {providerError && <div className="form-error">{providerError}</div>}
          <div className="form-actions">
            <button type="button" className="ghost-btn" onClick={() => setEditingProvider(false)}>
              取消
            </button>
            <button type="submit" className="primary-btn">
              保存 Provider
            </button>
          </div>
        </form>
      )}

      <div className="agent-list">
        {provider.kind !== 'native' && !workflowsLoaded && <div className="agent-empty-inline">加载中…</div>}
        {provider.kind !== 'native' && workflowsLoaded && workflows.length === 0 && (
          <div className="agent-empty-inline">
            该供应商下还没有 Agent。在 {providerConsoleLabel(provider.kind)} 创建后点上方刷新。
          </div>
        )}
        {provider.kind !== 'native' && workflows.filter((w) => !w.is_disabled).map((wf) => (
          <AgentCard
            key={wf.id}
            workflow={wf}
            stat={statsByWorkflow[wf.id] ?? null}
            onChatWithAgent={onChatWithAgent}
            onAfterMutate={onAfterMutate}
          />
        ))}
        {provider.kind === 'native' && !nativeLoaded && <div className="agent-empty-inline">加载中…</div>}
        {provider.kind === 'native' && nativeLoaded && providerNativeAgents.length === 0 && (
          <div className="agent-empty-inline">这个原生 Provider 里还没有 Agent。</div>
        )}
        {provider.kind === 'native' && nativeLoaded && providerNativeAgents.map((agent) => (
          <NativeAgentCard
            key={agent.id}
            agent={agent}
            modelOptions={modelOptions}
            modelError={modelError}
            onUpdate={updateNativeAgent}
            onRemove={removeNativeAgent}
            onAfterMutate={onAfterMutate}
          />
        ))}
      </div>
      {provider.kind === 'native' && (
        showNativeForm ? (
          <NativeAgentForm
            providerId={provider.id}
            modelOptions={modelOptions}
            modelError={modelError}
            skills={nativeSkills}
            onCancel={() => setShowNativeForm(false)}
            onSave={async (draft) => {
              const created = await createNativeAgent(draft)
              if (created) {
                setShowNativeForm(false)
                onAfterMutate()
              }
            }}
          />
        ) : (
          <button className="primary-btn add-native-agent-btn" onClick={() => setShowNativeForm(true)}>
            <Plus size={14} /> 添加 Agent
          </button>
        )
      )}
      {provider.kind === 'native' && modelError && <div className="form-error">{modelError}</div>}
      {provider.kind === 'native' && nativeError && <div className="form-error">{nativeError}</div>}
    </div>
  )
}

function LocalAgentMcpStatus({ provider }: { provider: Provider }) {
  const isClaude = provider.kind === 'claude-local'
  const health = objectMeta(provider.meta, isClaude ? 'claude_health' : 'codex_health')
  const toolMode = enumMeta(
    provider.meta,
    isClaude ? 'claude_tool_mode' : 'codex_tool_mode',
    ['mcp-first', 'browser-preflight', 'marker-only'],
    'mcp-first',
  )
  const mcpUrl = stringRecordValue(health, 'superleaf_mcp_url')
  const toolCount = numberRecordValue(health, 'superleaf_mcp_tool_count')
  const bound = isClaude
    ? Boolean(mcpUrl && toolCount > 0)
    : booleanRecordValue(health, 'codex_mcp_bound') || booleanRecordValue(health, 'codex_auto_mcp')
  const connected = booleanRecordValue(health, 'codex_app_server_connected')
  const contexts = numberRecordValue(health, 'mcp_contexts')
  const pending = numberRecordValue(health, 'mcp_pending_calls')
  const trust = stringRecordValue(health, 'codex_mcp_trust_level') || 'trusted'
  const version = stringRecordValue(health, 'claude_version')
  const statusTone = bound ? 'ok' : 'warn'
  return (
    <div className={`codex-mcp-status ${statusTone}`}>
      <div className="codex-mcp-status-title">
        {bound ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}
        <strong>SuperLeaf MCP</strong>
        <span className={`native-pill ${bound ? 'ok' : 'neutral'}`}>{bound ? 'bound' : 'not bound'}</span>
        <span className="native-pill neutral">{toolMode}</span>
      </div>
      <div className="codex-mcp-status-grid">
        {isClaude ? (
          <>
            <span>runtime: {version || 'Claude Code'}</span>
            <span>permission: {stringRecordValue(health, 'claude_permission_mode') || 'default'}</span>
          </>
        ) : (
          <>
            <span>app-server: {connected ? 'connected' : 'idle'}</span>
            <span>trust: {trust}</span>
          </>
        )}
        <span>tools: {toolCount || '-'}</span>
        <span>contexts: {contexts}</span>
        <span>pending: {pending}</span>
      </div>
      {mcpUrl && <div className="codex-mcp-url" title={mcpUrl}>{mcpUrl}</div>}
    </div>
  )
}

function NanobotToolAdapterStatus({ provider }: { provider: Provider }) {
  const reloadProviders = useSettingsStore((s) => s.load)
  const toolCount = numberRecordValue(provider.meta, 'superleaf_tool_count')
  const toolNames = stringArray(provider.meta.superleaf_tool_names)
  const adapterEndpoint = stringRecordValue(provider.meta, 'local_agent_host_endpoint') ||
    stringRecordValue(provider.meta, 'nanobot_adapter_endpoint')
  const adapterMode = stringRecordValue(provider.meta, 'nanobot_adapter_mode') || 'OpenAI tools'
  const adapterSource = stringRecordValue(provider.meta, 'nanobot_adapter_source')
  const statusTone = toolCount > 0 ? 'ok' : 'warn'
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')

  const syncAdapter = async () => {
    if (syncing) return
    setSyncing(true)
    setSyncError('')
    try {
      const apiKey = readBrowserNanobotApiKey(provider.id)
      const agents = await discoverBrowserNanobotAgents(provider.endpoint, apiKey)
      const localAgentHostEndpoint = nanobotLocalAgentHostEndpointFromRaw(agents[0]?.raw)
      await providerApi.syncBrowserNanobotModels(provider.id, {
        provider_name: provider.name,
        models: agents,
        local_agent_host_endpoint: localAgentHostEndpoint,
      })
      await reloadProviders()
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className={`codex-mcp-status ${statusTone}`}>
      <div className="codex-mcp-status-title">
        {toolCount > 0 ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}
        <strong>SuperLeaf Tool Adapter</strong>
        <span className={`native-pill ${toolCount > 0 ? 'ok' : 'neutral'}`}>
          {toolCount > 0 ? 'bound' : 'needs Local Host'}
        </span>
        <span className="native-pill neutral">{adapterMode}</span>
        {toolCount === 0 && (
          <button className="small-btn" type="button" onClick={() => void syncAdapter()} disabled={syncing}>
            {syncing ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
            同步
          </button>
        )}
      </div>
      <div className="codex-mcp-status-grid">
        <span>tools: {toolCount || '-'}</span>
        <span>fallback: marker</span>
        <span>bridge: browser</span>
        <span>host: {adapterEndpoint ? compactEndpointLabel(adapterEndpoint) : compactEndpointLabel(DEFAULT_NANOBOT_LOCAL_AGENT_HOST_ENDPOINT)}</span>
        {adapterSource && <span>source: {adapterSource}</span>}
      </div>
      {toolNames.length > 0 && (
        <div className="codex-mcp-url" title={toolNames.join(', ')}>
          {toolNames.join(', ')}
        </div>
      )}
      {syncError && <div className="codex-mcp-url error" title={syncError}>{syncError}</div>}
    </div>
  )
}

export function BackendStatusBar({
  reachable,
  error,
  onRetry,
}: {
  reachable: boolean | null
  error: string | null
  onRetry: () => void
}) {
  if (reachable === null || reachable) return null
  return (
    <div className="status-bar error">
      <CircleAlert size={14} />
      <span>无法连接到后端（{BACKEND_BASE}）。{error ? ` · ${error.slice(0, 120)}` : ''}</span>
      <button className="inline-btn" onClick={onRetry}>
        <RefreshCw size={12} /> 重试
      </button>
    </div>
  )
}

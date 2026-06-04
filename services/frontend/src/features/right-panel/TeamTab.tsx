/**
 * TeamTab — Agent 团队管理。
 *
 * UI 上每个"Agent"对应后端的一行 Provider（一个 endpoint + API key 组合就是
 * 一个 Agent）。同时显示从该 provider 同步出来的 cached workflows，让用户可
 * 以看到 Dify 那边到底有哪些 app。
 *
 * 后续 W7 会让这里直接挂"私聊"入口，所以预留 onChatWithAgent 钩子。
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import {
  CheckCircle2,
  CircleAlert,
  Loader2,
  MessageSquare,
  Medal,
  Plus,
  RefreshCw,
  Trash2,
  Ban,
  Bot,
  CheckCircle,
  Download,
  FileText,
  FolderOpen,
  Pencil,
  X,
} from 'lucide-react'
import type {
  CachedWorkflow,
  McpExecutionPolicy,
  McpGoldenTestResult,
  McpPreset,
  McpProbeResult,
  NativeAgent,
  NativeAgentDraft,
  NativeAgentMcpServer,
  NativeAgentPatch,
  NativeMcpServerConfig,
  NativeMcpServerConfigDraft,
  NativeMcpServerConfigPatch,
  OfficialBadgeStyle,
  Provider,
  ProviderDraft,
  ProviderModel,
  ProviderUpdate,
  Skill,
  SkillDraft,
  SkillMarketplaceEntry,
  SkillPatch,
  SkillRecipeDraft,
  WorkflowDefinition,
  WorkflowDefinitionDraft,
} from '../../services/backendApi'
import {
  BACKEND_BASE,
  getBrowserLocalServiceUrl,
  nativeAgentApi,
  providerApi,
} from '../../services/backendApi'
import { discoverBrowserNanobotAgents, storeBrowserNanobotApiKey } from '../../services/nanobotBrowserClient'
import { listBrowserCodexModels, probeBrowserCodex } from '../../services/codexBrowserClient'
import { statsApi, type AgentStat } from '../../services/statsApi'
import { computeAgentQuality } from '../../services/agentQuality'
import type { Selection } from '../../types/editor'
import type { RunEvent, NodeStatus } from '../../stores/workflowStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { useAnnotationStore } from '../../stores/annotationStore'
import { useProjectStore } from '../../stores/projectStore'
import { useNativeAgentStore } from '../../stores/nativeAgentStore'
import { trainingExportApi } from '../../services/trainingExportApi'
import { WorkflowDefinitionsPanel } from './WorkflowDefinitionsPanel'

interface TeamTabProps {
  workflows: CachedWorkflow[]
  workflowsLoaded: boolean
  workflowError: string | null
  definitions: WorkflowDefinition[]
  activeSelection: Selection | null
  runningMap: Record<string, boolean>
  eventsMap: Record<string, RunEvent[]>
  nodeStatusesMap: Record<string, NodeStatus[]>
  currentRoundMap: Record<string, number>
  maxRoundsMap: Record<string, number>
  onReload: () => void
  onChatWithAgent?: (workflow: CachedWorkflow) => void
  onRunDefinition: (definitionId: string, instruction: string) => void
  onTestDefinition: (definitionId: string, prompt: string) => void
  onCreateDefinition: (draft: WorkflowDefinitionDraft) => Promise<WorkflowDefinition | void>
  onUpdateDefinition: (id: string, draft: WorkflowDefinitionDraft) => Promise<WorkflowDefinition | void>
  onDeleteDefinition: (id: string) => Promise<void>
}

type SubTab = 'agents' | 'skills' | 'mcps' | 'workflows'
type McpCustomTab = 'remote' | 'stdio'

const DEFAULT_MCP_POLICY: McpExecutionPolicy = {
  remote_enabled: true,
  stdio_enabled: false,
  inline_config_enabled: false,
  remote_private_networks_enabled: false,
  allowed_transports: ['remote'],
}

const OfficialBadgeStyleContext = createContext<OfficialBadgeStyle>('metal')

export function TeamTab({
  workflows,
  workflowsLoaded,
  workflowError,
  definitions,
  activeSelection,
  runningMap,
  eventsMap,
  nodeStatusesMap,
  currentRoundMap,
  maxRoundsMap,
  onReload,
  onChatWithAgent,
  onRunDefinition,
  onTestDefinition,
  onCreateDefinition,
  onUpdateDefinition,
  onDeleteDefinition,
}: TeamTabProps) {
  const load = useSettingsStore((s) => s.load)
  const loaded = useSettingsStore((s) => s.loaded)
  const providers = useSettingsStore((s) => s.providers)
  const error = useSettingsStore((s) => s.error)
  const backendReachable = useSettingsStore((s) => s.backendReachable)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const nativeSkills = useNativeAgentStore((s) => s.skills)
  const marketplace = useNativeAgentStore((s) => s.marketplace)
  const marketplaceLoading = useNativeAgentStore((s) => s.marketplaceLoading)
  const mcpCatalog = useNativeAgentStore((s) => s.mcpCatalog)
  const mcpCatalogLoading = useNativeAgentStore((s) => s.mcpCatalogLoading)
  const mcpPolicy = useNativeAgentStore((s) => s.mcpPolicy)
  const mcpPolicyLoading = useNativeAgentStore((s) => s.mcpPolicyLoading)
  const mcpServers = useNativeAgentStore((s) => s.mcpServers)
  const mcpServersLoading = useNativeAgentStore((s) => s.mcpServersLoading)
  const mcpServersLoaded = useNativeAgentStore((s) => s.mcpServersLoaded)
  const nativeLoaded = useNativeAgentStore((s) => s.loaded)
  const nativeError = useNativeAgentStore((s) => s.error)
  const marketplaceError = useNativeAgentStore((s) => s.marketplaceError)
  const mcpCatalogError = useNativeAgentStore((s) => s.mcpCatalogError)
  const mcpPolicyError = useNativeAgentStore((s) => s.mcpPolicyError)
  const mcpServersError = useNativeAgentStore((s) => s.mcpServersError)
  const loadNativeAgents = useNativeAgentStore((s) => s.loadAll)
  const loadMarketplace = useNativeAgentStore((s) => s.loadMarketplace)
  const loadMcpPolicy = useNativeAgentStore((s) => s.loadMcpPolicy)
  const loadMcpCatalog = useNativeAgentStore((s) => s.loadMcpCatalog)
  const loadMcpServers = useNativeAgentStore((s) => s.loadMcpServers)
  const createMcpServer = useNativeAgentStore((s) => s.createMcpServer)
  const ensureMcpPresetServer = useNativeAgentStore((s) => s.ensureMcpPresetServer)
  const updateMcpServer = useNativeAgentStore((s) => s.updateMcpServer)
  const deleteMcpServer = useNativeAgentStore((s) => s.deleteMcpServer)
  const probeMcpServer = useNativeAgentStore((s) => s.probeMcpServer)
  const createSkill = useNativeAgentStore((s) => s.createSkill)
  const createRecipeSkill = useNativeAgentStore((s) => s.createRecipeSkill)
  const updateSkill = useNativeAgentStore((s) => s.updateSkill)
  const publishSkill = useNativeAgentStore((s) => s.publishSkill)
  const unpublishSkill = useNativeAgentStore((s) => s.unpublishSkill)
  const removeSkill = useNativeAgentStore((s) => s.removeSkill)
  const installMarketplaceSkill = useNativeAgentStore((s) => s.installMarketplaceSkill)
  const updateMarketplaceSkill = useNativeAgentStore((s) => s.updateMarketplaceSkill)
  const uninstallMarketplaceSkill = useNativeAgentStore((s) => s.uninstallMarketplaceSkill)
  const cloneMarketplaceSkillToLocal = useNativeAgentStore((s) => s.cloneMarketplaceSkillToLocal)

  const [subTab, setSubTab] = useState<SubTab>('agents')
  const [showForm, setShowForm] = useState(false)
  const [showDisabledModal, setShowDisabledModal] = useState(false)
  const [onlyTrainingCandidates, setOnlyTrainingCandidates] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [localHostDownloading, setLocalHostDownloading] = useState(false)
  const [localHostDownloadError, setLocalHostDownloadError] = useState<string | null>(null)
  const [officialBadgeStyle, setOfficialBadgeStyle] = useState<OfficialBadgeStyle>('metal')

  useEffect(() => {
    if (!loaded) load()
  }, [loaded, load])

  useEffect(() => {
    let cancelled = false
    nativeAgentApi.ui.officialBadge()
      .then((settings) => {
        if (!cancelled) setOfficialBadgeStyle(settings.style)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if ((subTab === 'skills' || subTab === 'agents' || subTab === 'mcps') && !nativeLoaded) void loadNativeAgents()
  }, [subTab, nativeLoaded, loadNativeAgents])

  useEffect(() => {
    if ((subTab === 'agents' || subTab === 'mcps') && !mcpPolicy && !mcpPolicyLoading) void loadMcpPolicy()
  }, [subTab, mcpPolicy, mcpPolicyLoading, loadMcpPolicy])

  useEffect(() => {
    if ((subTab === 'agents' || subTab === 'mcps') && !mcpCatalog && !mcpCatalogLoading) void loadMcpCatalog()
  }, [subTab, mcpCatalog, mcpCatalogLoading, loadMcpCatalog])

  useEffect(() => {
    if ((subTab === 'agents' || subTab === 'mcps') && !mcpServersLoaded && !mcpServersLoading) void loadMcpServers()
  }, [subTab, mcpServersLoaded, mcpServersLoading, loadMcpServers])

  useEffect(() => {
    if (subTab === 'skills' && !marketplace && !marketplaceLoading) void loadMarketplace()
  }, [subTab, marketplace, marketplaceLoading, loadMarketplace])

  // Group workflows by provider so each provider becomes one Agent block.
  const workflowsByProvider = workflows.reduce<Record<string, CachedWorkflow[]>>(
    (acc, w) => {
      ;(acc[w.provider_id] ??= []).push(w)
      return acc
    },
    {},
  )

  const activeCount = workflows.filter((w) => !w.is_disabled).length
  const disabledCount = workflows.filter((w) => w.is_disabled).length

  const handleTrainingExport = async () => {
    if (!currentProjectId || exporting) return
    setExporting(true)
    setExportError(null)
    try {
      await trainingExportApi.download(currentProjectId, {
        onlyTrainingCandidates,
      })
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '导出训练数据失败')
    } finally {
      setExporting(false)
    }
  }

  const handleLocalHostDownload = async () => {
    if (localHostDownloading) return
    setLocalHostDownloading(true)
    setLocalHostDownloadError(null)
    try {
      await nativeAgentApi.localAgentHost.download()
    } catch (err) {
      setLocalHostDownloadError(err instanceof Error ? err.message : '下载 Local Agent Host 失败')
    } finally {
      setLocalHostDownloading(false)
    }
  }

  return (
    <OfficialBadgeStyleContext.Provider value={officialBadgeStyle}>
      <div className="tab-content-wrapper">
        <div className="team-subtabs">
          <button
            className={subTab === 'agents' ? 'active' : ''}
            onClick={() => setSubTab('agents')}
          >
            Agent（{activeCount}）
          </button>
          <button
            className={subTab === 'skills' ? 'active' : ''}
            onClick={() => setSubTab('skills')}
          >
            Skill（{nativeSkills.length}）
          </button>
          {/* MCP 标签统计用户已拥有的 MCP 配置数量；市场条目数量只在 MCP 面板内部展示。 */}
          <button
            className={subTab === 'mcps' ? 'active' : ''}
            onClick={() => setSubTab('mcps')}
          >
            MCP（{mcpServers.length}）
          </button>
          <button
            className={subTab === 'workflows' ? 'active' : ''}
            onClick={() => setSubTab('workflows')}
          >
            Workflow（{definitions.length}）
          </button>
        </div>

      {subTab === 'agents' && (
        <>
          <div className="tab-header-row">
            <span>Agent 团队：{activeCount} 个活跃 · {disabledCount} 个禁用</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="small-btn"
                onClick={() => void handleLocalHostDownload()}
                disabled={localHostDownloading}
                title="下载 SuperLeaf Local Agent Host，用于连接本机 Nanobot / Codex"
              >
                {localHostDownloading ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                Local Host
              </button>
              {disabledCount > 0 && (
                <button
                  className="small-btn"
                  onClick={() => setShowDisabledModal(true)}
                  title="查看已禁用的 Agent"
                >
                  查看已禁用
                </button>
              )}
              <button className="small-btn" onClick={onReload} title="重新同步 Agent 列表">
                <RefreshCw size={12} /> 同步
              </button>
            </div>
          </div>

          <BackendStatusBar reachable={backendReachable} error={error} onRetry={load} />

          {workflowError && <div className="tab-error">{workflowError}</div>}
          {localHostDownloadError && <div className="tab-error">{localHostDownloadError}</div>}
          {mcpCatalogError && <div className="tab-error">MCP catalog: {mcpCatalogError}</div>}
          {mcpPolicyError && <div className="tab-error">MCP policy: {mcpPolicyError}</div>}

          <section className="agent-export-panel">
            <div>
              <h3>批注训练数据</h3>
              <p>
                导出当前项目中可见的批注评价样本，用于 LLM wiki 构建。导出包只包含批注所在行内容，但仍可能包含敏感文本。
              </p>
              <label className="agent-export-toggle">
                <input
                  type="checkbox"
                  checked={onlyTrainingCandidates}
                  onChange={(event) => setOnlyTrainingCandidates(event.target.checked)}
                />
                仅导出已标记为训练数据的数据
              </label>
              {exportError && <div className="tab-error">{exportError}</div>}
            </div>
            <button
              className="small-btn"
              onClick={() => void handleTrainingExport()}
              disabled={!currentProjectId || exporting}
              title="下载批注训练数据 ZIP"
            >
              {exporting ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
              {exporting ? '导出中' : '导出 ZIP'}
            </button>
          </section>

          {loaded && providers.length === 0 && !showForm && (
            <div className="tab-empty">
              还没有配置任何 Agent。点击下方按钮添加 Nanobot / Dify 等 Agent，
              系统会自动同步可用的 Agent。
            </div>
          )}

          <div className="agent-team-list">
            {providers.map((provider) => (
              <ProviderBlock
                key={provider.id}
                provider={provider}
                workflows={workflowsByProvider[provider.id] ?? []}
                workflowsLoaded={workflowsLoaded}
                onChatWithAgent={onChatWithAgent}
                onAfterMutate={onReload}
              />
            ))}
          </div>

          {showForm ? (
            <ProviderForm onClose={() => setShowForm(false)} onCreated={onReload} />
          ) : (
            <button className="primary-btn add-provider-btn" onClick={() => setShowForm(true)}>
              <Plus size={14} /> 添加 Agent
            </button>
          )}

          {showDisabledModal && (
            <DisabledAgentsModal
              workflows={workflows.filter((w) => w.is_disabled)}
              onClose={() => setShowDisabledModal(false)}
              onAfterMutate={onReload}
            />
          )}
        </>
      )}

      {subTab === 'skills' && (
        <SkillManagementPanel
          skills={nativeSkills}
          marketplaceSkills={marketplace?.skills ?? []}
          loading={marketplaceLoading}
          error={marketplaceError || nativeError}
          onRefresh={() => void loadMarketplace()}
          onCreatePrivateSkill={createSkill}
          onCreateRecipeSkill={createRecipeSkill}
          onInstallMarketplaceSkill={installMarketplaceSkill}
          onUpdateMarketplaceSkill={updateMarketplaceSkill}
          onUninstallMarketplaceSkill={uninstallMarketplaceSkill}
          onCloneMarketplaceSkillToLocal={cloneMarketplaceSkillToLocal}
          onUpdateSkill={updateSkill}
          onPublishSkill={publishSkill}
          onUnpublishSkill={unpublishSkill}
          onRemoveSkill={removeSkill}
        />
      )}

      {subTab === 'mcps' && (
        <McpManagementPanel
          presets={mcpCatalog?.presets ?? []}
          servers={mcpServers}
          policy={mcpPolicy}
          policyLoading={mcpPolicyLoading}
          loading={mcpCatalogLoading || mcpPolicyLoading || mcpServersLoading || !nativeLoaded}
          error={mcpPolicyError || mcpCatalogError || mcpServersError || nativeError}
          onRefresh={() => {
            void loadMcpPolicy()
            void loadMcpCatalog()
            void loadMcpServers()
            if (!nativeLoaded) void loadNativeAgents()
          }}
          onCreateServer={createMcpServer}
          onEnsurePresetServer={ensureMcpPresetServer}
          onUpdateServer={updateMcpServer}
          onDeleteServer={deleteMcpServer}
          onProbeServer={probeMcpServer}
        />
      )}

      {subTab === 'workflows' && (
        <WorkflowDefinitionsPanel
          workflows={workflows}
          definitions={definitions}
          activeSelection={activeSelection}
          runningMap={runningMap}
          eventsMap={eventsMap}
          nodeStatusesMap={nodeStatusesMap}
          currentRoundMap={currentRoundMap}
          maxRoundsMap={maxRoundsMap}
          onRunDefinition={onRunDefinition}
          onTestDefinition={onTestDefinition}
          onCreateDefinition={onCreateDefinition}
          onUpdateDefinition={onUpdateDefinition}
          onDeleteDefinition={onDeleteDefinition}
        />
      )}
      </div>
    </OfficialBadgeStyleContext.Provider>
  )
}

interface ProviderBlockProps {
  provider: Provider
  workflows: CachedWorkflow[]
  workflowsLoaded: boolean
  onChatWithAgent?: (workflow: CachedWorkflow) => void
  onAfterMutate: () => void
}

function ProviderBlock({
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
    workspace_path: codexWorkspacePath(provider),
    ...codexProviderSettings(provider),
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
      workspace_path: codexWorkspacePath(provider),
      ...codexProviderSettings(provider),
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
    if (provider.kind === 'codex-local') {
      patch.workspace_path = providerPatch.workspace_path?.trim() ?? ''
      Object.assign(patch, codexSettingsPatch(providerPatch))
      if (!patch.workspace_path) {
        setProviderError('Codex Local 需要填写代码项目 workspace path')
        return
      }
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
          {provider.kind === 'codex-local' && (
            <>
              <label className="full">
                <span>Workspace Path</span>
                <input
                  value={providerPatch.workspace_path ?? ''}
                  onChange={(event) => setProviderPatch((prev) => ({ ...prev, workspace_path: event.target.value }))}
                  placeholder="/Users/me/code/my-paper-project"
                />
              </label>
              <CodexSettingsFields
                draft={providerPatch}
                modelOptions={modelOptions}
                onChange={(patch) => setProviderPatch((prev) => ({ ...prev, ...patch }))}
              />
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

interface AgentCardProps {
  workflow: CachedWorkflow
  stat: AgentStat | null
  onChatWithAgent?: (workflow: CachedWorkflow) => void
  onAfterMutate: () => void
}

function AgentCard({ workflow, stat, onChatWithAgent, onAfterMutate }: AgentCardProps) {
  const disableWorkflow = useWorkflowStore((s) => s.disableWorkflow)
  const [busy, setBusy] = useState(false)

  const handleDisable = async () => {
    if (!confirm(`禁用 Agent「${workflow.name}」？禁用后将不会出现在 @mention 列表中。`)) return
    setBusy(true)
    await disableWorkflow(workflow.id)
    setBusy(false)
    onAfterMutate()
  }

  return (
    <div
      className="agent-card"
      title={workflow.description || `${workflow.kind} · ${workflow.external_id}`}
    >
      <div className="agent-avatar" style={{ background: agentColor(workflow.kind) }}>
        {workflow.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="agent-info">
        <strong>{workflow.name}</strong>
        <span>
          {workflow.kind}
          {workflow.description ? ` · ${workflow.description}` : workflow.external_id ? ` · ${workflow.external_id}` : ''}
        </span>
        <AgentStatsRow stat={stat} />
        <AgentQualityRow workflowId={workflow.id} />
      </div>
      <div className="agent-card-actions">
        {onChatWithAgent && (
          <button
            className="tree-action-btn"
            title="开始对话"
            onClick={() => onChatWithAgent(workflow)}
          >
            <MessageSquare size={12} />
          </button>
        )}
        <button
          className="tree-action-btn"
          title="禁用 Agent"
          onClick={handleDisable}
          disabled={busy}
        >
          {busy ? <Loader2 size={12} className="spin" /> : <Ban size={12} />}
        </button>
      </div>
    </div>
  )
}

interface NativeAgentCardProps {
  agent: NativeAgent
  modelOptions: ProviderModel[]
  modelError: string | null
  onUpdate: (id: string, patch: NativeAgentPatch) => Promise<NativeAgent | null>
  onRemove: (id: string) => Promise<boolean>
  onAfterMutate: () => void
}

function NativeAgentCard({ agent, modelOptions, modelError, onUpdate, onRemove, onAfterMutate }: NativeAgentCardProps) {
  const skills = useNativeAgentStore((s) => s.skills)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleRemove = async () => {
    if (!confirm(`删除 Agent「${agent.name}」？`)) return
    setBusy(true)
    const removed = await onRemove(agent.id)
    if (removed) onAfterMutate()
    setBusy(false)
  }

  if (editing) {
    return (
      <NativeAgentForm
        providerId={agent.provider_id}
        agent={agent}
        modelOptions={modelOptions}
        modelError={modelError}
        skills={skills}
        onCancel={() => setEditing(false)}
        onSave={async (draft) => {
          const updated = await onUpdate(agent.id, draft)
          if (updated) {
            setEditing(false)
            onAfterMutate()
          }
        }}
      />
    )
  }

  return (
    <div className="agent-card native">
      <div className="agent-avatar" style={{ background: agentColor('native') }}>
        {agent.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="agent-info">
        <strong>{agent.name}</strong>
        <span>
          原生 · {agent.model}
          {agent.description ? ` · ${agent.description}` : ''}
        </span>
        <span className="agent-stats-empty">{agent.is_enabled ? '已启用' : '已停用'}</span>
        <span className={`agent-stats-empty ${agent.setup_status === 'setup_failed' ? 'error' : ''}`}>
          Workspace: {agent.setup_status || 'ready'}
          {agent.setup_log ? ` · ${agent.setup_log.slice(0, 80)}` : ''}
        </span>
      </div>
      <div className="agent-card-actions">
        <button
          className="tree-action-btn"
          title={agent.is_enabled ? '停用 Agent' : '启用 Agent'}
          onClick={async () => {
            const updated = await onUpdate(agent.id, { is_enabled: !agent.is_enabled })
            if (updated) onAfterMutate()
          }}
        >
          {agent.is_enabled ? <Ban size={12} /> : <CheckCircle size={12} />}
        </button>
        <button className="tree-action-btn" title="编辑 Agent" onClick={() => setEditing(true)}>
          <Pencil size={12} />
        </button>
        <button className="tree-action-btn" title="删除 Agent" onClick={handleRemove} disabled={busy}>
          {busy ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
        </button>
      </div>
    </div>
  )
}

function mcpServersFromRuntime(runtimeConfig: Record<string, unknown> | undefined): NativeAgentMcpServer[] {
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

function splitArgs(value: string): string[] {
  return value.split(/\s+/).map((part) => part.trim()).filter(Boolean)
}

function joinArgs(value: string[] | undefined): string {
  return (value ?? []).join(' ')
}

function parseEnvLines(value: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of value.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key.trim()) env[key.trim()] = rest.join('=').trim()
  }
  return env
}

function parseEnvLinesStrict(value: string): { env: Record<string, string>; error?: string } {
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

function parseDelimitedList(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean)
  if (typeof value === 'string') return splitArgs(value)
  return []
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

function parseMcpJsonSnippet(value: string): { parsed?: ParsedMcpJson; error?: string } {
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

function stringListFromRuntime(runtimeConfig: Record<string, unknown> | undefined, key: string): string[] {
  const value = runtimeConfig?.[key]
  if (!Array.isArray(value)) return []
  return value.map(String).map((item) => item.trim()).filter(Boolean)
}

function mcpPresetIdsFromRuntime(runtimeConfig: Record<string, unknown> | undefined): string[] {
  return stringListFromRuntime(runtimeConfig, 'mcp_preset_ids')
}

function mcpServerIdsFromRuntime(runtimeConfig: Record<string, unknown> | undefined): string[] {
  return stringListFromRuntime(runtimeConfig, 'mcp_server_ids')
}

function writeMcpSelection(
  runtimeConfig: Record<string, unknown> | undefined,
  presetIds: string[],
  serverIds: string[],
): Record<string, unknown> {
  const { mcp_servers: _legacyMcpServers, ...rest } = runtimeConfig ?? {}
  return {
    ...rest,
    mcp_preset_ids: [...new Set(presetIds)],
    mcp_server_ids: [...new Set(serverIds)],
  }
}

function mcpEffectivePolicy(policy: McpExecutionPolicy | null | undefined): McpExecutionPolicy {
  return policy ?? DEFAULT_MCP_POLICY
}

function mcpTransportKind(value: string | undefined | null): 'remote' | 'stdio' | 'unsupported' {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-')
  if (['remote', 'http', 'https', 'sse', 'streamable-http'].includes(normalized)) return 'remote'
  if (!normalized || ['stdio', 'local', 'local-stdio'].includes(normalized)) return 'stdio'
  return 'unsupported'
}

function mcpTransportLabel(value: string | undefined | null): string {
  const kind = mcpTransportKind(value)
  if (kind === 'remote') return 'REMOTE'
  if (kind === 'stdio') return 'STDIO'
  return String(value || 'UNKNOWN').toUpperCase()
}

function mcpTransportAllowed(value: string | undefined | null, policy: McpExecutionPolicy): boolean {
  const kind = mcpTransportKind(value)
  if (kind === 'remote') return policy.remote_enabled
  if (kind === 'stdio') return policy.stdio_enabled
  return false
}

function mcpTransportPolicyBlock(value: string | undefined | null, policy: McpExecutionPolicy): string {
  const kind = mcpTransportKind(value)
  if (kind === 'remote' && !policy.remote_enabled) return '当前部署未开启 Remote MCP endpoint。'
  if (kind === 'stdio' && !policy.stdio_enabled) return '当前部署未开启 Local Trusted MCP（YLW_MCP_STDIO_ENABLED=false）。'
  if (kind === 'unsupported') return `当前部署不支持 ${String(value || 'unknown')} MCP transport。`
  return ''
}

function mcpServerTransportKind(server: NativeMcpServerConfig | NativeAgentMcpServer): 'remote' | 'stdio' | 'unsupported' {
  return mcpTransportKind(server.transport || (server.endpoint ? 'remote' : 'stdio'))
}

function mcpServerAllowedByPolicy(server: NativeMcpServerConfig | NativeAgentMcpServer, policy: McpExecutionPolicy): boolean {
  return mcpTransportAllowed(server.transport || (server.endpoint ? 'remote' : 'stdio'), policy)
}

function mcpServerPolicyBlock(server: NativeMcpServerConfig | NativeAgentMcpServer, policy: McpExecutionPolicy): string {
  return mcpTransportPolicyBlock(server.transport || (server.endpoint ? 'remote' : 'stdio'), policy)
}

function mcpPresetTransportKind(preset: McpPreset): 'remote' | 'stdio' | 'unsupported' {
  return mcpTransportKind(preset.transport.type || (mcpPresetEndpoint(preset) ? 'remote' : 'stdio'))
}

function mcpPresetPolicyBlock(preset: McpPreset, policy: McpExecutionPolicy): string {
  return mcpTransportPolicyBlock(preset.transport.type || (mcpPresetEndpoint(preset) ? 'remote' : 'stdio'), policy)
}

function mcpPresetEndpoint(preset: McpPreset): string {
  return String(preset.transport.endpoint || preset.transport.url || '').trim()
}

function mcpServerEndpoint(server: NativeMcpServerConfig | NativeAgentMcpServer): string {
  return String(server.endpoint || (mcpServerTransportKind(server) === 'remote' ? server.command : '') || '').trim()
}

function mcpPresetTargetLine(preset: McpPreset): string {
  if (mcpPresetTransportKind(preset) === 'remote') return mcpPresetEndpoint(preset) || preset.transport.command || '(empty)'
  return preset.transport.command || '(empty)'
}

function mcpServerTargetLine(server: NativeMcpServerConfig): string {
  if (mcpServerTransportKind(server) === 'remote') return mcpServerEndpoint(server) || '(empty endpoint)'
  return `${server.command} ${joinArgs(server.args)}`.trim() || '(empty command)'
}

function mcpNameFromEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return url.hostname.replace(/^www\./, '') || 'remote-mcp'
  } catch {
    return endpoint.replace(/^https?:\/\//i, '').split('/')[0] || 'remote-mcp'
  }
}

function serverFromPreset(preset: McpPreset): NativeAgentMcpServer {
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

function mcpQualifiedName(preset: McpPreset): string {
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

function mcpRegistryLabel(preset: McpPreset): string {
  return preset.registry === 'official' ? '官方' : '外部'
}

function isOfficialRecommendedMcp(preset?: McpPreset): boolean {
  return Boolean(preset?.official_recommended || preset?.registry === 'official')
}

function OfficialMcpBadge() {
  return <OfficialBadge ariaLabel="官方推荐 MCP" title="官方推荐 MCP" />
}

function OfficialSkillBadge() {
  return <OfficialBadge ariaLabel="官方 Skill" title="官方 Skill" />
}

function OfficialBadge({ ariaLabel, title }: { ariaLabel: string; title: string }) {
  const style = useContext(OfficialBadgeStyleContext)
  return (
    <span className={`official-badge ${style}`} aria-label={ariaLabel} title={title}>
      <Medal size={12} />
      官方
    </span>
  )
}

function ownedMcpName(server: NativeMcpServerConfig, preset?: McpPreset): string {
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

function mcpPresetSourceLabel(preset: McpPreset): string {
  const repo = preset.source?.repo
  if (typeof repo === 'string' && repo.trim()) return repo
  const url = preset.source?.url
  if (typeof url === 'string' && url.trim()) return url
  return 'custom preset'
}

function mcpPresetSourceUrl(preset: McpPreset): string {
  const url = preset.source?.url
  if (typeof url === 'string' && url.trim()) return url.trim()
  const repo = preset.source?.repo
  if (typeof repo === 'string' && repo.includes('/')) return `https://github.com/${repo.trim()}`
  return ''
}

function mcpPresetEnvSummary(preset: McpPreset): string {
  if (preset.env_schema.length === 0) return '无 Env'
  const required = preset.env_schema.filter((field) => field.required)
  const reliable = preset.env_schema.filter((field) => field.required_for_reliable_use && !field.required)
  if (required.length > 0) return `必填 Env: ${required.map((field) => field.name).join(', ')}`
  if (reliable.length > 0) return `推荐 Env: ${reliable.map((field) => field.name).join(', ')}`
  return `Env: ${preset.env_schema.map((field) => field.name).join(', ')}`
}

function mcpPresetVerificationSummary(preset: McpPreset): string {
  const status = preset.verification.status || 'unknown'
  const grade = preset.verification.grade ? ` · ${preset.verification.grade}` : ''
  const golden = preset.verification.golden_tests?.length ? ` · ${preset.verification.golden_tests.length} golden` : ''
  return `${status}${grade}${golden}`
}

function mcpPresetAllowedTools(preset: McpPreset): string[] {
  return preset.tool_policy.default_allowed_tools?.length
    ? preset.tool_policy.default_allowed_tools
    : preset.tool_policy.recommended_tools ?? []
}

function mcpPresetTransportLabel(preset: McpPreset): string {
  return mcpTransportLabel(preset.transport.type || (mcpPresetEndpoint(preset) ? 'remote' : 'stdio'))
}

function mcpPresetTransportSupported(preset: McpPreset, policy: McpExecutionPolicy): boolean {
  return mcpTransportAllowed(preset.transport.type || (mcpPresetEndpoint(preset) ? 'remote' : 'stdio'), policy)
}

function mcpProbeDetailText(probe: McpProbeResult): string {
  const warning = probe.warnings.length > 0 ? `; ${probe.warnings.join('; ')}` : ''
  const missing = probe.missing_tools.length > 0 ? `; missing: ${probe.missing_tools.join(', ')}` : ''
  return `${probe.tools.length} tools${missing}${warning}`
}

function mcpConnectivityOk(server: NativeMcpServerConfig, check?: McpCheckState): boolean {
  return connectivityPassed(check) || (!check && (server.last_probe_status || server.status) === 'ok')
}

function mcpFunctionalityOk(server: NativeMcpServerConfig, check?: McpCheckState): boolean {
  return goldenPassed(check) || (!check && server.last_golden_status === 'ok')
}

function mcpServerHealthLine(server: NativeMcpServerConfig, check?: McpCheckState): string {
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

function mcpAgentPickerHint(
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

type McpCheckState = {
  busy: 'probe' | 'golden' | null
  probe?: McpProbeResult
  golden?: McpGoldenTestResult
  error?: string
}

function NativeAgentForm({
  providerId,
  agent,
  modelOptions,
  modelError,
  skills,
  onCancel,
  onSave,
}: {
  providerId: string
  agent?: NativeAgent
  modelOptions: ProviderModel[]
  modelError?: string | null
  skills: Skill[]
  onCancel: () => void
  onSave: (draft: NativeAgentDraft) => Promise<void>
}) {
  const initialModel = agent?.model || modelOptions[0]?.id || 'gpt-4.1-mini'
  const [modelMode, setModelMode] = useState<'select' | 'custom'>(
    modelOptions.length > 0 && (!agent || modelOptions.some((model) => model.id === agent.model))
      ? 'select'
      : 'custom',
  )
  const [draft, setDraft] = useState<NativeAgentDraft>({
    name: agent?.name ?? '',
    description: agent?.description ?? '',
    provider_id: providerId,
    model: initialModel,
    instructions: agent?.instructions ?? '',
    agent_md: agent?.agent_md || agent?.instructions || '',
    skill_ids: agent?.skill_ids ?? [],
    output_contract: agent?.output_contract ?? 'annotation',
    runtime_config: agent?.runtime_config ?? {},
    is_enabled: agent?.is_enabled ?? true,
  })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const mcpCatalog = useNativeAgentStore((s) => s.mcpCatalog)
  const mcpCatalogLoading = useNativeAgentStore((s) => s.mcpCatalogLoading)
  const loadMcpCatalog = useNativeAgentStore((s) => s.loadMcpCatalog)
  const mcpPolicy = useNativeAgentStore((s) => s.mcpPolicy)
  const mcpPolicyLoading = useNativeAgentStore((s) => s.mcpPolicyLoading)
  const loadMcpPolicy = useNativeAgentStore((s) => s.loadMcpPolicy)
  const mcpConfigs = useNativeAgentStore((s) => s.mcpServers)
  const mcpConfigsLoaded = useNativeAgentStore((s) => s.mcpServersLoaded)
  const mcpConfigsLoading = useNativeAgentStore((s) => s.mcpServersLoading)
  const loadMcpServers = useNativeAgentStore((s) => s.loadMcpServers)
  const mcpPresets = useMemo(() => mcpCatalog?.presets ?? [], [mcpCatalog])
  const presetById = useMemo(() => new Map(mcpPresets.map((preset) => [preset.id, preset])), [mcpPresets])
  const ownedPresetMcpConfigs = useMemo(() => mcpConfigs.filter((server) => Boolean(server.preset_id)), [mcpConfigs])
  const customMcpConfigs = useMemo(() => mcpConfigs.filter((server) => !server.preset_id), [mcpConfigs])
  const selectedPresetIds = useMemo(() => new Set(mcpPresetIdsFromRuntime(draft.runtime_config)), [draft.runtime_config])
  const selectedServerIds = useMemo(() => new Set(mcpServerIdsFromRuntime(draft.runtime_config)), [draft.runtime_config])
  const legacyMcpServers = mcpServersFromRuntime(draft.runtime_config)
  const effectiveMcpPolicy = useMemo(() => mcpEffectivePolicy(mcpPolicy), [mcpPolicy])

  const modelInOptions = modelOptions.some((model) => model.id === draft.model)
  const effectiveModelMode = modelMode === 'select' && modelInOptions ? 'select' : 'custom'

  useEffect(() => {
    if (!mcpCatalog && !mcpCatalogLoading) void loadMcpCatalog()
  }, [mcpCatalog, mcpCatalogLoading, loadMcpCatalog])

  useEffect(() => {
    if (!mcpPolicy && !mcpPolicyLoading) void loadMcpPolicy()
  }, [mcpPolicy, mcpPolicyLoading, loadMcpPolicy])

  useEffect(() => {
    if (!mcpConfigsLoaded && !mcpConfigsLoading) void loadMcpServers()
  }, [mcpConfigsLoaded, mcpConfigsLoading, loadMcpServers])

  useEffect(() => {
    if (agent || !mcpConfigsLoaded || ownedPresetMcpConfigs.length === 0) return
    setDraft((prev) => {
      if (
        mcpPresetIdsFromRuntime(prev.runtime_config).length > 0 ||
        mcpServerIdsFromRuntime(prev.runtime_config).length > 0 ||
        mcpServersFromRuntime(prev.runtime_config).length > 0
      ) {
        return prev
      }
      const defaultServerIds = ownedPresetMcpConfigs
        .filter((server) => (
          server.is_enabled &&
          mcpServerAllowedByPolicy(server, effectiveMcpPolicy) &&
          presetById.get(server.preset_id)?.verification?.status === 'verified'
        ))
        .map((server) => server.id)
      if (defaultServerIds.length === 0) return prev
      return {
        ...prev,
        runtime_config: writeMcpSelection(prev.runtime_config, [], defaultServerIds),
      }
    })
  }, [agent, effectiveMcpPolicy, mcpConfigsLoaded, ownedPresetMcpConfigs, presetById])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setFormError(null)
    if (!draft.name.trim() || !draft.model.trim()) {
      setFormError('名称和模型不能为空')
      return
    }
    setSaving(true)
    await onSave({
      ...draft,
      name: draft.name.trim(),
      model: draft.model.trim(),
      instructions: draft.instructions.trim(),
      agent_md: (draft.agent_md || draft.instructions).trim(),
    })
    setSaving(false)
  }

  const updateMcpSelection = (presetIds: Set<string>, serverIds: Set<string>) => {
    setDraft((prev) => ({
      ...prev,
      runtime_config: writeMcpSelection(prev.runtime_config, [...presetIds], [...serverIds]),
    }))
  }

  const toggleOwnedMcp = (server: NativeMcpServerConfig, checked: boolean) => {
    const nextPresetIds = new Set(selectedPresetIds)
    const nextServerIds = new Set(selectedServerIds)
    if (checked) {
      nextServerIds.add(server.id)
      if (server.preset_id) nextPresetIds.delete(server.preset_id)
    } else {
      nextServerIds.delete(server.id)
      if (server.preset_id) nextPresetIds.delete(server.preset_id)
    }
    updateMcpSelection(nextPresetIds, nextServerIds)
  }

  return (
    <form className="native-agent-inline-form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          <span>Agent 名称</span>
          <input
            value={draft.name}
            onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            autoFocus={!agent}
          />
        </label>
        <label>
          <span>模型</span>
          <div className="model-picker">
            <select
              value={effectiveModelMode === 'select' ? draft.model : '__custom__'}
              onChange={(event) => {
                const value = event.target.value
                if (value === '__custom__') {
                  setModelMode('custom')
                  return
                }
                setModelMode('select')
                setDraft((prev) => ({ ...prev, model: value }))
              }}
            >
              <option value="__custom__">自定义模型名</option>
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name || model.id}
                </option>
              ))}
            </select>
          </div>
          {effectiveModelMode === 'custom' && (
            <input
              value={draft.model}
              onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))}
              placeholder="gpt-4.1-mini"
            />
          )}
          {modelError && <small className="model-error">{modelError}</small>}
        </label>
      </div>
      <label className="full">
        <span>描述</span>
        <input
          value={draft.description}
          onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
          placeholder="这个 Agent 负责什么"
        />
      </label>
      <label className="full">
        <span>AGENT.md</span>
        <textarea
          value={draft.agent_md ?? ''}
          onChange={(event) => setDraft((prev) => ({ ...prev, agent_md: event.target.value, instructions: event.target.value }))}
          rows={5}
          placeholder="写入该 Agent 的 .agents/AGENT.md"
        />
      </label>
      <fieldset className="skill-picker-field">
        <legend>Skill 装配</legend>
        {skills.length === 0 ? (
          <div className="agent-empty-inline">本地 Skill 库为空。先在 Skill 页面安装市场 Skill 或添加自定义 Skill。</div>
        ) : (
          <div className="skill-picker">
            {skills.map((skill) => {
              const checked = draft.skill_ids?.includes(skill.id) ?? false
              return (
                <label key={skill.id} className={`skill-check ${checked ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const next = new Set(draft.skill_ids ?? [])
                      if (event.target.checked) next.add(skill.id)
                      else next.delete(skill.id)
                      setDraft((prev) => ({ ...prev, skill_ids: [...next] }))
                    }}
                  />
                  <span>{skillLabel(skill)}</span>
                  {skill.source === 'marketplace' ? <OfficialSkillBadge /> : <small>{skillPillLabel(skill)}</small>}
                </label>
              )
            })}
          </div>
        )}
      </fieldset>
      <fieldset className="skill-picker-field mcp-picker-field">
        <legend>MCP 工具</legend>
        <p className="mcp-field-note">Agent 这里只选择要开放的 MCP。命令、Env、工具白名单在团队管理的 MCP 标签页维护。</p>
        {mcpConfigsLoading && mcpConfigs.length === 0 && (
          <div className="agent-empty-inline">正在读取拥有的 MCP...</div>
        )}
        {!mcpConfigsLoading && mcpConfigs.length === 0 && (
          <div className="agent-empty-inline">还没有拥有的 MCP。先到 MCP 标签页从市场添加，或创建自定义 MCP。</div>
        )}
        <div className="skill-picker">
          {ownedPresetMcpConfigs.map((server) => {
            const preset = presetById.get(server.preset_id)
            const legacySelected = legacyMcpServers.some((legacy) => legacy.id === server.preset_id && legacy.enabled)
            const checked = selectedServerIds.has(server.id) || selectedPresetIds.has(server.preset_id) || legacySelected
            const policyAllowed = mcpServerAllowedByPolicy(server, effectiveMcpPolicy)
            const hint = mcpAgentPickerHint(server, preset, effectiveMcpPolicy)
            return (
              <label key={server.id} className={`skill-check ${checked ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && (!server.is_enabled || !policyAllowed)}
                  onChange={(event) => toggleOwnedMcp(server, event.target.checked)}
                />
                <span>{ownedMcpName(server, preset)}</span>
                <small>
                  {preset ? `${mcpRegistryLabel(preset)} · ${preset.category}` : '已拥有 MCP'} · {server.is_enabled ? '已启用' : '已停用'}
                  <span className={`mcp-picker-status ${hint.tone}`}>{hint.label}</span>
                  {hint.detail ? ` · ${hint.detail}` : ''}
                </small>
              </label>
            )
          })}
          {customMcpConfigs.map((server) => {
            const checked = selectedServerIds.has(server.id)
            const policyAllowed = mcpServerAllowedByPolicy(server, effectiveMcpPolicy)
            const hint = mcpAgentPickerHint(server, undefined, effectiveMcpPolicy)
            return (
              <label key={server.id} className={`skill-check ${checked ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && (!server.is_enabled || !policyAllowed)}
                  onChange={(event) => toggleOwnedMcp(server, event.target.checked)}
                />
                <span>{ownedMcpName(server)}</span>
                <small>
                  自定义 · {server.is_enabled ? '已启用' : '已停用'}
                  <span className={`mcp-picker-status ${hint.tone}`}>{hint.label}</span>
                  {hint.detail ? ` · ${hint.detail}` : ''}
                </small>
              </label>
            )
          })}
        </div>
        {legacyMcpServers.length > 0 && (
          <div className="agent-empty-inline">检测到 {legacyMcpServers.length} 个旧版内联 MCP 配置；公开部署默认不会执行内联配置，下一次修改 MCP 选择后会迁移为引用式配置。</div>
        )}
      </fieldset>
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-actions">
        <button type="button" className="ghost-btn" onClick={onCancel} disabled={saving}>
          取消
        </button>
        <button type="submit" className="primary-btn" disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : agent ? '保存 Agent' : '添加 Agent'}
        </button>
      </div>
    </form>
  )
}

function McpManagementPanel({
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

function envPlaceholderForPreset(preset?: McpPreset): string {
  if (!preset || preset.env_schema.length === 0) return 'KEY=value'
  return preset.env_schema.map((field) => `${field.name}=`).join('\n')
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'MCP 操作失败'
}

function SkillManagementPanel({
  skills,
  marketplaceSkills,
  loading,
  error,
  onRefresh,
  onCreatePrivateSkill,
  onCreateRecipeSkill,
  onInstallMarketplaceSkill,
  onUpdateMarketplaceSkill,
  onUninstallMarketplaceSkill,
  onCloneMarketplaceSkillToLocal,
  onUpdateSkill,
  onPublishSkill,
  onUnpublishSkill,
  onRemoveSkill,
}: {
  skills: Skill[]
  marketplaceSkills: SkillMarketplaceEntry[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onCreatePrivateSkill: (draft: SkillDraft) => Promise<Skill | null>
  onCreateRecipeSkill: (draft: SkillRecipeDraft) => Promise<Skill | null>
  onInstallMarketplaceSkill: (id: string) => Promise<SkillMarketplaceEntry | null>
  onUpdateMarketplaceSkill: (id: string) => Promise<SkillMarketplaceEntry | null>
  onUninstallMarketplaceSkill: (id: string) => Promise<boolean>
  onCloneMarketplaceSkillToLocal: (id: string, name: string) => Promise<Skill | null>
  onUpdateSkill: (id: string, patch: SkillPatch) => Promise<Skill | null>
  onPublishSkill: (id: string) => Promise<Skill | null>
  onUnpublishSkill: (id: string) => Promise<Skill | null>
  onRemoveSkill: (id: string) => Promise<boolean>
}) {
  const navigate = useNavigate()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showPrivateForm, setShowPrivateForm] = useState(false)
  const [showRecipeForm, setShowRecipeForm] = useState(false)
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null)
  const [marketSearch, setMarketSearch] = useState('')
  const [pendingShareIds, setPendingShareIds] = useState<Set<string>>(new Set())
  const privateSkills = skills.filter((skill) => skill.source === 'upload')
  const marketplaceInstalled = skills.filter((skill) => skill.source === 'marketplace')
  const customRecipeSkills = skills.filter((skill) => skill.source === 'custom')
  const projectSkills = skills.filter((skill) => skill.source === 'project')
  const filteredMarketplaceSkills = marketplaceSkills.filter((entry) => skillMarketMatches(entry, marketSearch))

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    try {
      await action()
    } finally {
      setBusyId(null)
    }
  }

  const openProjectSkill = (skill: Skill) => {
    if (!skill.project_id) return
    navigate(`/projects/${skill.project_id}`)
  }

  return (
    <section className="skill-management-panel">
      <div className="tab-header-row">
        <span>Skill 管理：{skills.length} 个可用 · {projectSkills.length} 个项目 · {marketplaceInstalled.length} 个市场 · {customRecipeSkills.length} 个自定义 · {privateSkills.length} 个私有</span>
        <button className="small-btn" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 同步市场
        </button>
      </div>
      {error && <div className="tab-error">{error}</div>}

      <section className="skill-library-section">
        <div className="skill-market-header">
          <div>
            <strong>本地 Skill 库</strong>
            <span>Agent 只能装配这里已经存在的 Skill。</span>
          </div>
          <div className="skill-market-actions">
            <button className="ghost-btn small" type="button" onClick={() => setShowRecipeForm((v) => !v)}>
              <Plus size={12} /> 自定义 npx
            </button>
            <button className="ghost-btn small" type="button" onClick={() => setShowPrivateForm((v) => !v)}>
              <Plus size={12} /> 私有 SKILL.md
            </button>
          </div>
        </div>
        {showRecipeForm && (
          <RecipeSkillForm
            onCancel={() => setShowRecipeForm(false)}
            onSave={async (draft) => {
              const created = await onCreateRecipeSkill(draft)
              if (created) setShowRecipeForm(false)
              return created
            }}
          />
        )}
        {showPrivateForm && (
          <PrivateSkillForm
            onCancel={() => setShowPrivateForm(false)}
            onSave={async (draft) => {
              const created = await onCreatePrivateSkill(draft)
              if (created) setShowPrivateForm(false)
              return created
            }}
          />
        )}
        <div className="skill-local-list">
          {skills.length === 0 && <div className="agent-empty-inline">本地还没有 Skill。</div>}
          {skills.map((skill) => (
            <div key={skill.id} className="skill-local-row">
              <div className="skill-market-copy">
                <div className="skill-market-name-row">
                  {skill.source === 'project' && skill.project_id ? (
                    <button
                      className="skill-name-button"
                      type="button"
                      title="打开对应的 Skill project"
                      onClick={() => openProjectSkill(skill)}
                    >
                      {skillLabel(skill)}
                    </button>
                  ) : skill.can_edit && skill.source !== 'marketplace' && skill.source !== 'project' ? (
                    <button className="skill-name-button" type="button" onClick={() => setEditingSkill(skill)}>
                      {skillLabel(skill)}
                    </button>
                  ) : (
                    <strong>{skillLabel(skill)}</strong>
                  )}
                  {skill.used_by_agent_count > 0 && (
                    <span
                      className="skill-usage-badge"
                      title={`有 ${skill.used_by_agent_count} 个 Agent 在使用这个 Skill`}
                    >
                      <Bot size={11} />×{skill.used_by_agent_count}
                    </span>
                  )}
                </div>
                <span>{skill.description || '无描述'}</span>
                {skill.source === 'project' && (
                  <small>项目缓存 v{skill.cache_version || 0}{skill.cache_updated_at ? ` · ${new Date(skill.cache_updated_at).toLocaleString()}` : ''}</small>
                )}
              </div>
              <div className="skill-market-actions">
                {skill.source === 'marketplace' ? (
                  <OfficialSkillBadge />
                ) : (
                  <span className={`native-pill ${skillPillTone(skill)}`}>{skillPillLabel(skill, pendingShareIds.has(skill.id))}</span>
                )}
                <button
                  className="ghost-btn small"
                  type="button"
                  title="下载 Skill"
                  disabled={busyId === skill.id}
                  onClick={() => {
                    void run(skill.id, () => nativeAgentApi.skills.download(skill.id, `${skill.name || 'skill'}.zip`))
                  }}
                >
                  <Download size={12} /> 下载
                </button>
                <button
                  className="ghost-btn small danger"
                  type="button"
                  disabled={busyId === skill.id}
                  onClick={async () => {
                    // Fetch usage on-demand so the confirm names the impacted
                    // agents. Falls back to a generic prompt if the lookup
                    // fails — better to allow delete than to block on a
                    // network error.
                    let usage: Awaited<ReturnType<typeof nativeAgentApi.skills.usage>> = []
                    try {
                      usage = await nativeAgentApi.skills.usage(skill.id)
                    } catch {
                      // ignore; treat as "no usage info"
                    }
                    const lines = [`从本地 Skill 库移除「${skillLabel(skill)}」？`]
                    if (skill.source === 'project') {
                      lines.push('')
                      lines.push('源 Skill Project 会保留；以后打开该项目并更新 Skill 缓存即可重新加载。')
                    }
                    if (usage.length > 0) {
                      lines.push('')
                      lines.push(`以下 ${usage.length} 个 Agent 正在使用，删除后这个 Skill 会从它们身上自动解绑：`)
                      for (const u of usage.slice(0, 8)) lines.push(`  · ${u.agent_name}`)
                      if (usage.length > 8) lines.push(`  · 还有 ${usage.length - 8} 个…`)
                    }
                    if (!confirm(lines.join('\n'))) return
                    void run(skill.id, () => onRemoveSkill(skill.id))
                  }}
                >
                  {skill.source === 'project' ? '移除' : '删除'}
                </button>
              </div>
            </div>
          ))}
        </div>
        <EditSkillDialog
          skill={editingSkill}
          isSharePending={editingSkill ? pendingShareIds.has(editingSkill.id) : false}
          onOpenChange={(open) => {
            if (!open) setEditingSkill(null)
          }}
          onPublish={async (skill) => {
            const updated = await onPublishSkill(skill.id)
            if (updated) {
              setPendingShareIds((prev) => {
                const next = new Set(prev)
                next.delete(skill.id)
                return next
              })
              setEditingSkill(updated)
            }
            return updated
          }}
          onUnpublish={async (skill) => {
            const updated = await onUnpublishSkill(skill.id)
            if (updated) {
              setPendingShareIds((prev) => {
                const next = new Set(prev)
                next.delete(skill.id)
                return next
              })
              setEditingSkill(updated)
            }
            return updated
          }}
          onRemove={async (skill) => {
            const removed = await onRemoveSkill(skill.id)
            if (removed) setEditingSkill(null)
            return removed
          }}
          onSave={async (skill, patch) => {
            const updated = await onUpdateSkill(skill.id, patch)
            if (updated) {
              if (skill.visibility === 'public') {
                setPendingShareIds((prev) => new Set(prev).add(skill.id))
              }
              setEditingSkill(updated)
            }
            return updated
          }}
        />
        <div className="skill-management-note">市场和自定义 npx Skill 这里只登记配方；创建或保存 Agent 时才会真正安装到该 Agent 的 .agents/skills。</div>
      </section>

      <section className="skill-market-panel">
        <div className="skill-market-header">
        <div>
          <strong>Skill Market</strong>
          <span>来自官方 catalog；安装后成为当前用户的本地 Skill。</span>
        </div>
        <button className="ghost-btn small" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
        </div>
        <label className="skill-market-search">
          <span>搜索 Skill Market</span>
          <input
            value={marketSearch}
            onChange={(event) => setMarketSearch(event.target.value)}
            placeholder="搜索作者、Skill 名、描述、标签"
          />
        </label>
        {marketplaceSkills.length === 0 ? (
          <div className="agent-empty-inline">还没有同步到 Skill 市场。</div>
        ) : filteredMarketplaceSkills.length === 0 ? (
          <div className="agent-empty-inline">没有匹配「{marketSearch.trim()}」的 Skill。</div>
        ) : (
          <div className="skill-market-list">
            {filteredMarketplaceSkills.map((entry) => {
              return (
                <div key={entry.id} className="skill-market-row">
                  <div className="skill-market-copy">
                    <strong>{entry.id}</strong>
                    <span>{entry.description}</span>
                    <small>{entry.installed ? `已在本地 Skill 库登记 v${entry.installed_version || entry.version}` : entry.install_command}</small>
                  </div>
                  <div className="skill-market-actions">
                    <OfficialSkillBadge />
                    {entry.installed && <span className="native-pill ok">本地</span>}
                    {entry.installed && entry.update_available && (
                      <button
                        className="ghost-btn small"
                        type="button"
                        disabled={busyId === entry.id}
                        onClick={() => void run(entry.id, () => onUpdateMarketplaceSkill(entry.id))}
                      >
                        更新
                      </button>
                    )}
                    {entry.installed && (
                      <button
                        className="ghost-btn small"
                        type="button"
                        disabled={busyId === entry.id}
                        onClick={() => {
                          const defaultName = `${entry.display_name || entry.name || entry.id}-local`
                          const name = prompt('本地 Skill 名称：', defaultName)
                          if (name === null) return
                          void run(entry.id, () => onCloneMarketplaceSkillToLocal(entry.id, name.trim() || defaultName))
                        }}
                      >
                        复制到本地
                      </button>
                    )}
                    <button
                      className="ghost-btn small"
                      type="button"
                      disabled={busyId === entry.id}
                      onClick={() => {
                        if (entry.installed) void run(entry.id, () => onUninstallMarketplaceSkill(entry.id))
                        else void run(entry.id, () => onInstallMarketplaceSkill(entry.id))
                      }}
                    >
                      {entry.installed ? '移除本地' : '安装到本地'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </section>
  )
}

function RecipeSkillForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void
  onSave: (draft: SkillRecipeDraft) => Promise<Skill | null>
}) {
  const [npxCommand, setNpxCommand] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [skillName, setSkillName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [tagText, setTagText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    const command = npxCommand.trim()
    const parsed = command ? parseSkillAddCommand(command) : null
    const source = sourceUrl.trim() || parsed?.source || ''
    const name = skillName.trim() || parsed?.skillName || ''
    if (!source) {
      setError('请填写 npx skills add 指令，或 GitHub Skill 文件夹 URL / npx 支持的 package')
      return
    }
    if (!isDirectSkillSource(source) && !name) {
      setError('repo/package 模式需要填写 skill name；直接 GitHub Skill 文件夹 URL 可以留空')
      return
    }
    setSaving(true)
    const created = await onSave({
      name: displayName.trim() || name || inferSkillNameFromSource(source),
      description: description.trim(),
      repo_url: source,
      source_url: source,
      skill_name: name,
      install_command: command || customNpxCommand(source, name),
      tags: normalizeTagText(tagText),
    })
    if (!created) setError('保存失败，请检查上方错误提示')
    setSaving(false)
  }

  return (
    <form className="native-agent-inline-form" onSubmit={handleSubmit}>
      <label className="full">
        <span>npx 指令</span>
        <input
          value={npxCommand}
          onChange={(event) => setNpxCommand(event.target.value)}
          placeholder="npx skills add https://github.com/vercel-labs/skills --skill find-skills"
        />
      </label>
      <label className="full">
        <span>npx 来源</span>
        <input
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="https://github.com/owner/repo/tree/main/skills/author@skill"
        />
      </label>
      <div className="form-row">
        <label>
          <span>Skill name</span>
          <input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="repo/package 模式才需要" />
        </label>
        <label>
          <span>显示名称</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="默认从来源推断" />
        </label>
      </div>
      <label className="full">
        <span>描述</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label className="full">
        <span>标签</span>
        <input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="review, latex" />
      </label>
      {(sourceUrl.trim() || npxCommand.trim()) && (
        <div className="skill-folder-summary">
          <strong>{recipePreviewName(sourceUrl.trim(), skillName.trim(), npxCommand.trim())}</strong>
          <span>{customNpxCommand(sourceUrl.trim() || parseSkillAddCommand(npxCommand.trim())?.source || '', skillName.trim() || parseSkillAddCommand(npxCommand.trim())?.skillName || '')}</span>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="ghost-btn" onClick={onCancel} disabled={saving}>取消</button>
        <button type="submit" className="primary-btn" disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : '保存配方'}
        </button>
      </div>
    </form>
  )
}

function PrivateSkillForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void
  onSave: (draft: SkillDraft) => Promise<Skill | null>
}) {
  const [draft, setDraft] = useState<SkillDraft>({
    name: '',
    folder_name: '',
    entry_filename: '',
    description: '',
    content: '',
    tags: [],
  })
  const [tagText, setTagText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDirectoryChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null)
    const files = Array.from(event.target.files ?? [])
    const entry = files.find((file) => {
      const parts = file.webkitRelativePath.split('/')
      return parts.length === 2 && parts[1] === 'SKILL.md'
    })
    if (!entry) {
      setDraft((prev) => ({ ...prev, name: '', folder_name: '', entry_filename: '', content: '' }))
      setError('请选择根目录包含精确命名 SKILL.md 的 Skill 文件夹')
      return
    }
    const folderName = entry.webkitRelativePath.split('/')[0] ?? ''
    const content = await entry.text()
    setDraft((prev) => ({
      ...prev,
      name: folderName,
      folder_name: folderName,
      entry_filename: 'SKILL.md',
      content,
    }))
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null)
    const file = event.target.files?.[0]
    if (!file) return
    if (file.name !== 'SKILL.md') {
      setDraft((prev) => ({ ...prev, name: '', folder_name: '', entry_filename: '', content: '' }))
      setError('单文件上传时文件名必须精确为 SKILL.md')
      return
    }
    const content = await file.text()
    const inferredName = inferSkillName(content)
    setDraft((prev) => ({
      ...prev,
      name: inferredName,
      folder_name: '',
      entry_filename: 'SKILL.md',
      content,
    }))
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    const skillName = (draft.folder_name || draft.name || inferSkillName(draft.content)).trim()
    if (!skillName || draft.entry_filename !== 'SKILL.md' || !draft.content.trim()) {
      setError('请选择包含根目录 SKILL.md 的文件夹，或直接选择 SKILL.md 文件')
      return
    }
    setSaving(true)
    const created = await onSave({
      ...draft,
      name: skillName,
      folder_name: draft.folder_name?.trim() ?? '',
      entry_filename: 'SKILL.md',
      description: draft.description?.trim() ?? '',
      content: draft.content.trim(),
      tags: tagText.split(',').map((tag) => tag.trim()).filter(Boolean),
    })
    if (!created) setError('保存失败，请检查上方错误提示')
    setSaving(false)
  }

  return (
    <form className="native-agent-inline-form" onSubmit={handleSubmit}>
      <div className="skill-upload-picker-row">
        <label className="skill-upload-picker">
          <input
            type="file"
            {...{ webkitdirectory: '', directory: '' }}
            onChange={handleDirectoryChange}
          />
          <span className="skill-upload-button">
            <FolderOpen size={13} /> 选择文件夹
          </span>
          <small>根目录需包含 SKILL.md</small>
        </label>
        <label className="skill-upload-picker">
          <input type="file" accept=".md,text/markdown,text/plain" onChange={handleFileChange} />
          <span className="skill-upload-button">
            <FileText size={13} /> 选择 SKILL.md
          </span>
          <small>仅上传单个 SKILL.md</small>
        </label>
      </div>
      <div className="form-row">
        <label>
          <span>标签</span>
          <input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="review, latex" />
        </label>
      </div>
      {draft.folder_name && (
        <div className="skill-folder-summary">
          <strong>{draft.folder_name}</strong>
          <span>已读取根目录 SKILL.md；后端会保存为 GitHub用户名@{draft.folder_name}</span>
        </div>
      )}
      {!draft.folder_name && draft.content && (
        <div className="skill-folder-summary">
          <strong>{draft.name || 'SKILL'}</strong>
          <span>已读取单文件 SKILL.md；后端会用 GitHub用户名@技能名 作为逻辑文件夹包裹。</span>
        </div>
      )}
      <label className="full">
        <span>描述</span>
        <input value={draft.description ?? ''} onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))} />
      </label>
      <textarea value={draft.content} readOnly rows={5} placeholder="选择 Skill 文件夹后显示 SKILL.md 内容预览。" />
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="ghost-btn" onClick={onCancel} disabled={saving}>取消</button>
        <button type="submit" className="primary-btn" disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : '保存 Skill'}
        </button>
      </div>
    </form>
  )
}

function EditSkillDialog({
  skill,
  isSharePending,
  onOpenChange,
  onSave,
  onPublish,
  onUnpublish,
  onRemove,
}: {
  skill: Skill | null
  isSharePending: boolean
  onOpenChange: (open: boolean) => void
  onSave: (skill: Skill, patch: SkillPatch) => Promise<Skill | null>
  onPublish: (skill: Skill) => Promise<Skill | null>
  onUnpublish: (skill: Skill) => Promise<Skill | null>
  onRemove: (skill: Skill) => Promise<boolean>
}) {
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [tagText, setTagText] = useState('')
  const [shareScope, setShareScope] = useState<'private' | 'server'>('private')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentPatch = (): SkillPatch => ({
    description: description.trim(),
    content: content.trim(),
    tags: normalizeTagText(tagText),
  })

  const isDirty = Boolean(skill && skillPatchChanged(skill, currentPatch()))
  const canShare = Boolean(skill && skill.visibility === 'private' && shareScope === 'server')
  const canUpdateShared = Boolean(skill && skill.visibility === 'public' && shareScope === 'server' && (isDirty || isSharePending))
  const canUnshare = Boolean(skill && skill.visibility === 'public')

  useEffect(() => {
    if (!skill) return
    setDescription(skill.description)
    setContent(skill.content)
    setTagText((skill.tags ?? []).join(', '))
    setShareScope(skill.visibility === 'public' ? 'server' : 'private')
    setError(null)
  }, [skill])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!skill) return
    setError(null)
    if (!content.trim()) {
      setError('SKILL.md 内容不能为空')
      return
    }
    setSaving(true)
    await onSave(skill, currentPatch())
    setSaving(false)
  }

  const handlePublish = async () => {
    if (!skill) return
    if (shareScope !== 'server') return
    if (skill.visibility === 'private' && !confirm('共享后，当前服务器上的其他可见用户可装配此 Skill；这不会提交到 Skill Market。继续共享？')) return
    if (skill.visibility === 'public' && !canUpdateShared) return
    setSaving(true)
    let publishTarget = skill
    if (isDirty) {
      const updated = await onSave(skill, currentPatch())
      if (updated) publishTarget = updated
    }
    await onPublish(publishTarget)
    setSaving(false)
  }

  const handleUnpublish = async () => {
    if (!skill) return
    if (!canUnshare) return
    setSaving(true)
    await onUnpublish(skill)
    setSaving(false)
  }

  const handleRemove = async () => {
    if (!skill) return
    if (!confirm(`删除 Skill「${skillLabel(skill)}」？`)) return
    setSaving(true)
    await onRemove(skill)
    setSaving(false)
  }

  return (
    <Dialog.Root open={Boolean(skill)} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="skill-dialog-overlay" />
        <Dialog.Content className="skill-dialog-content">
          <div className="skill-dialog-header">
            <div>
              <Dialog.Title className="skill-dialog-title">{skill ? skillLabel(skill) : '修改 Skill'}</Dialog.Title>
              <p>修改会更新当前服务器上的这份 Skill 内容。</p>
            </div>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="关闭"><X size={18} /></button>
            </Dialog.Close>
          </div>
          {skill && (
            <form className="skill-dialog-form" onSubmit={handleSubmit}>
              <label>
                <span>描述</span>
                <input value={description} onChange={(event) => setDescription(event.target.value)} />
              </label>
              <label>
                <span>标签</span>
                <input value={tagText} onChange={(event) => setTagText(event.target.value)} />
              </label>
              <div className="skill-share-row">
                <label>
                  <span>共享范围</span>
                  <select value={shareScope} onChange={(event) => setShareScope(event.target.value as 'private' | 'server')} disabled={saving}>
                    <option value="private">私有</option>
                    <option disabled>项目（后续）</option>
                    <option disabled>合作者（后续）</option>
                    <option value="server">服务器</option>
                    <option disabled>Market（后续）</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={handlePublish}
                  disabled={saving || (skill.visibility === 'public' ? !canUpdateShared : !canShare)}
                >
                  {skill.visibility === 'public' ? '更新' : '共享'}
                </button>
                <button type="button" className="ghost-btn" onClick={handleUnpublish} disabled={saving || !canUnshare}>
                  取消共享
                </button>
              </div>
              <label>
                <span>SKILL.md</span>
                <textarea className="skill-md-textarea" value={content} onChange={(event) => setContent(event.target.value)} rows={12} />
              </label>
              {error && <div className="form-error">{error}</div>}
              <div className="form-actions">
                <button type="button" className="danger-btn" onClick={handleRemove} disabled={saving}>
                  删除
                </button>
                <button type="button" className="ghost-btn" onClick={() => onOpenChange(false)} disabled={saving}>取消</button>
                <button type="submit" className="primary-btn" disabled={saving}>
                  {saving ? <Loader2 size={14} className="spin" /> : '保存修改'}
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function skillLabel(skill: Skill): string {
  return skill.public_name || skill.name
}

function customNpxCommand(source: string, skillName: string): string {
  if (!source) return ''
  const parts = ['npx', '--yes', 'skills', 'add', source]
  if (skillName && !isDirectSkillSource(source)) {
    parts.push('--skill', skillName)
  }
  parts.push('--agent', 'codex', '--copy', '--yes')
  return parts.join(' ')
}

function isDirectSkillSource(source: string): boolean {
  return source.includes('github.com/') && source.includes('/tree/')
}

function parseSkillAddCommand(command: string): { source: string; skillName: string } | null {
  const parts = splitCommand(command)
  const skillsIndex = parts.findIndex((part, index) => part === 'skills' && parts[index + 1] === 'add')
  if (skillsIndex < 0 || !parts[skillsIndex + 2]) return null
  const rest = parts.slice(skillsIndex + 3)
  let skillName = ''
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index]
    if (part === '--skill' && rest[index + 1]) {
      skillName = rest[index + 1]
      break
    }
    if (part.startsWith('--skill=')) {
      skillName = part.slice('--skill='.length)
      break
    }
  }
  return { source: parts[skillsIndex + 2], skillName }
}

function splitCommand(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^['"]|['"]$/g, ''))
}

function recipePreviewName(source: string, skillName: string, command: string): string {
  const parsed = command ? parseSkillAddCommand(command) : null
  const resolvedSource = source || parsed?.source || ''
  const resolvedSkill = skillName || parsed?.skillName || ''
  const github = resolvedSource.match(/^https:\/\/github\.com\/([^/]+)\/(.+)$/)
  if (github) {
    const tail = github[2].replace(/\/$/, '').split('/').pop()?.replace(/\.git$/, '') ?? ''
    if (tail.includes('@')) return tail
    if (resolvedSkill) return `${github[1]}@${resolvedSkill}`
  }
  return resolvedSkill || inferSkillNameFromSource(resolvedSource)
}

function skillPillLabel(skill: Skill, pendingShare = false): string {
  if (skill.visibility === 'system' || skill.source === 'bundled') return '内置'
  if (skill.source === 'project') return '项目'
  if (skill.source === 'marketplace') return '市场'
  if (skill.source === 'custom') return '自定义 npx'
  if (skill.visibility === 'public') return pendingShare ? '共享·待更新' : '共享'
  return '私有'
}

function skillPillTone(skill: Skill): string {
  if (skill.visibility === 'public' || skill.source === 'bundled' || skill.source === 'marketplace') return 'ok'
  if (skill.source === 'project') return 'ok'
  if (skill.source === 'custom') return 'neutral'
  return ''
}

function normalizeTagText(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean)
}

function skillPatchChanged(skill: Skill, patch: SkillPatch): boolean {
  const currentTags = [...(skill.tags ?? [])].map((tag) => tag.trim()).filter(Boolean).sort()
  const nextTags = [...(patch.tags ?? [])].map((tag) => tag.trim()).filter(Boolean).sort()
  return (
    (skill.description ?? '').trim() !== (patch.description ?? '').trim() ||
    (skill.content ?? '').trim() !== (patch.content ?? '').trim() ||
    currentTags.join('\n') !== nextTags.join('\n')
  )
}

function inferSkillName(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim() || 'SKILL'
    if (trimmed.toLowerCase().startsWith('name:')) return trimmed.split(':').slice(1).join(':').trim() || 'SKILL'
  }
  return 'SKILL'
}

function inferSkillNameFromSource(source: string): string {
  const cleaned = source.trim().replace(/\/$/, '')
  const last = cleaned.split('/').pop()?.replace(/\.git$/, '')
  return last || 'custom-skill'
}

function skillMarketMatches(entry: SkillMarketplaceEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const haystack = [
    entry.id,
    entry.name,
    entry.display_name,
    entry.author_github,
    entry.description,
    entry.license,
    ...(entry.tags ?? []),
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(normalized)
}

function mcpMarketMatches(preset: McpPreset, query: string): boolean {
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

function AgentStatsRow({ stat }: { stat: AgentStat | null }) {
  if (!stat || stat.runs === 0) {
    return <span className="agent-stats-empty">尚无运行记录</span>
  }
  const acceptRate =
    stat.accept_rate === null ? '—' : `${Math.round(stat.accept_rate * 100)}%`
  const decided = stat.accepts + stat.rejects
  const avgLatency =
    stat.avg_latency_ms === null
      ? '—'
      : stat.avg_latency_ms < 1000
        ? `${Math.round(stat.avg_latency_ms)} ms`
        : `${(stat.avg_latency_ms / 1000).toFixed(1)} s`
  return (
    <div className="agent-stats-row">
      <span className="agent-stat" title="完成的运行次数">
        产出 {stat.runs}
      </span>
      <span
        className="agent-stat"
        title={`采纳 ${stat.accepts} / 拒绝 ${stat.rejects}`}
      >
        接受率 {acceptRate}
        {decided > 0 && <span className="agent-stat-dim"> ({decided})</span>}
      </span>
      <span className="agent-stat" title="完成运行的平均耗时">
        平均 {avgLatency}
      </span>
    </div>
  )
}

function AgentQualityRow({ workflowId }: { workflowId: string }) {
  const annotationItems = useAnnotationStore((s) => s.items)
  const evaluationsByAnnotation = useAnnotationStore((s) => s.evaluationsByAnnotation)
  const quality = useMemo(
    () => computeAgentQuality(workflowId, annotationItems, evaluationsByAnnotation),
    [workflowId, annotationItems, evaluationsByAnnotation],
  )
  if (quality.total === 0) return null
  const positiveRate =
    quality.positiveRate === null ? '—' : `${Math.round(quality.positiveRate * 100)}%`
  return (
    <div className="agent-stats-row agent-quality-row">
      <span className="agent-stat agent-stat-quality positive" title="用户判为有用的评价数">
        ✅ {quality.positive}
      </span>
      <span className="agent-stat agent-stat-quality negative" title="用户判为无用的评价数">
        ❎ {quality.negative}
      </span>
      <span className="agent-stat" title="有用 / 有用+无用">
        好评率 {positiveRate}
        <span className="agent-stat-dim"> ({quality.total})</span>
      </span>
      {quality.topTag && (
        <span className="agent-stat" title={`最常见标签 (${quality.topTagCount} 次)`}>
          Top #{quality.topTag}
        </span>
      )}
    </div>
  )
}

function ProviderForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const create = useSettingsStore((s) => s.create)
  const probe = useSettingsStore((s) => s.probe)
  const loadProviders = useSettingsStore((s) => s.load)
  const [draft, setDraft] = useState<ProviderDraft>({
    name: '',
    kind: 'dify-local',
    endpoint: 'http://localhost:8080/v1',
    api_key: '',
    activate: true,
    transport: 'backend',
    workspace_path: '',
    ...DEFAULT_CODEX_SETTINGS,
  })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [codexModels, setCodexModels] = useState<ProviderModel[]>([])
  const [codexModelsLoading, setCodexModelsLoading] = useState(false)

  useEffect(() => {
    if (draft.kind !== 'codex-local') {
      setCodexModels([])
      setCodexModelsLoading(false)
      return
    }
    const endpoint = draft.endpoint.trim()
    if (!endpoint) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      setCodexModelsLoading(true)
      listBrowserCodexModels(endpoint)
        .then((models) => {
          if (cancelled) return
          setCodexModels(models)
        })
        .catch(() => {
          if (cancelled) return
          setCodexModels([])
        })
        .finally(() => {
          if (!cancelled) setCodexModelsLoading(false)
        })
    }, 500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [draft.kind, draft.endpoint])

  const handleKindChange = (kind: ProviderDraft['kind']) => {
    setDraft((d) => ({
      ...d,
      kind,
      transport: kind === 'nanobot' || kind === 'codex-local' ? 'browser' : 'backend',
      endpoint:
        kind === 'dify-cloud'
          ? 'https://api.dify.ai/v1'
          : kind === 'claude-direct'
            ? 'https://api.anthropic.com'
            : kind === 'native'
              ? 'https://api.openai.com/v1'
            : kind === 'nanobot'
              ? getBrowserLocalServiceUrl(8787)
              : kind === 'codex-local'
                ? getBrowserLocalServiceUrl(8787)
                : 'http://localhost:8080/v1',
      api_key: (kind === 'nanobot' || kind === 'codex-local') && !d.api_key.trim() ? 'dummy' : d.api_key,
      ...(kind === 'codex-local' ? DEFAULT_CODEX_SETTINGS : {}),
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    const filledDraft: ProviderDraft = {
      ...draft,
      api_key: (draft.kind === 'nanobot' || draft.kind === 'codex-local') && !draft.api_key.trim() ? 'dummy' : draft.api_key,
    }
    if (!filledDraft.name.trim() || !filledDraft.endpoint.trim() || !filledDraft.api_key.trim()) {
      setFormError('名称 / endpoint / API key 都不能为空')
      return
    }
    if (filledDraft.kind === 'codex-local' && !filledDraft.workspace_path?.trim()) {
      setFormError('Codex Local 需要填写代码项目 workspace path')
      return
    }
    setSubmitting(true)
    let browserAgents: Awaited<ReturnType<typeof discoverBrowserNanobotAgents>> | null = null
    let codexHealth: Record<string, unknown> | null = null
    let codexModelsForSync = codexModels
    if (filledDraft.kind === 'nanobot' && filledDraft.transport === 'browser') {
      try {
        browserAgents = await discoverBrowserNanobotAgents(filledDraft.endpoint, filledDraft.api_key)
      } catch (err) {
        setSubmitting(false)
        setFormError(
          err instanceof Error
            ? `浏览器无法访问本机 Nanobot：${err.message}`
            : '浏览器无法访问本机 Nanobot',
        )
        return
      }
    }
    if (filledDraft.kind === 'codex-local') {
      try {
        codexHealth = await probeBrowserCodex(filledDraft.endpoint)
      } catch (err) {
        setSubmitting(false)
        setFormError(
          err instanceof Error
            ? `浏览器无法访问本机 Codex：${err.message}`
            : '浏览器无法访问本机 Codex',
        )
        return
      }
      if (codexModelsForSync.length === 0) {
        try {
          codexModelsForSync = await listBrowserCodexModels(filledDraft.endpoint)
        } catch {
          codexModelsForSync = []
        }
      }
    }
    const result = await create(filledDraft)
    if (result) {
      if (filledDraft.kind === 'nanobot' && filledDraft.transport === 'browser' && browserAgents) {
        storeBrowserNanobotApiKey(result.id, filledDraft.api_key)
        await providerApi.syncBrowserNanobotModels(result.id, {
          provider_name: result.name,
          models: browserAgents,
        })
        await loadProviders()
      } else if (filledDraft.kind === 'codex-local' && codexHealth) {
        await providerApi.syncBrowserCodexAgent(result.id, { health: codexHealth, models: codexModelsForSync })
        await loadProviders()
      } else {
        await probe(result.id)
      }
      setSubmitting(false)
      onClose()
      onCreated()
    } else {
      setSubmitting(false)
      setFormError('创建失败，查看控制台')
    }
  }

  return (
    <form className="provider-form embedded" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          <span>名称</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={
              draft.kind === 'nanobot'
                ? 'Agent 名字，比如 PhD Mentor'
                : 'My Dify'
            }
            autoFocus
          />
        </label>
        <label>
          <span>类型</span>
          <select value={draft.kind} onChange={(e) => handleKindChange(e.target.value as ProviderDraft['kind'])}>
            <option value="dify-local">Dify (本地)</option>
            <option value="dify-cloud">Dify Cloud</option>
            <option value="claude-direct">Claude API 直连</option>
            <option value="nanobot">Nanobot</option>
            <option value="native">原生 Agent</option>
            <option value="codex-local">Codex Local</option>
          </select>
        </label>
      </div>
      <label className="full">
        <span>Endpoint</span>
        <input
          value={draft.endpoint}
          onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
          placeholder={
            draft.kind === 'nanobot'
              ? getBrowserLocalServiceUrl(8787)
              : draft.kind === 'codex-local'
                ? getBrowserLocalServiceUrl(8787)
              : draft.kind === 'native'
                ? 'https://api.openai.com/v1'
                : 'http://localhost:8080/v1'
          }
        />
      </label>
      {draft.kind === 'codex-local' && (
        <>
          <label className="full">
            <span>Workspace Path</span>
            <input
              value={draft.workspace_path ?? ''}
              onChange={(e) => setDraft({ ...draft, workspace_path: e.target.value })}
              placeholder="/Users/me/code/my-paper-project"
            />
          </label>
          <CodexSettingsFields
            draft={draft}
            modelOptions={codexModels}
            modelLoading={codexModelsLoading}
            onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
          />
        </>
      )}
      {draft.kind === 'nanobot' && (
        <label className="full">
          <span>调用位置</span>
          <select
            value={draft.transport ?? 'browser'}
            onChange={(e) => setDraft({ ...draft, transport: e.target.value as 'backend' | 'browser' })}
          >
            <option value="browser">浏览器直连本机 Nanobot</option>
            <option value="backend">后端直连 Nanobot</option>
          </select>
        </label>
      )}
      <label className="full">
        <span>API Key</span>
        <input
          type="password"
          value={draft.api_key}
          onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
          placeholder="app-xxxxx / sk-xxxxx"
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.activate}
          onChange={(e) => setDraft({ ...draft, activate: e.target.checked })}
        />
        <span>设为默认供应商</span>
      </label>
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-actions">
        <button type="button" className="ghost-btn" onClick={onClose} disabled={submitting}>
          取消
        </button>
        <button type="submit" className="primary-btn" disabled={submitting}>
          {submitting ? <Loader2 size={14} className="spin" /> : '保存'}
        </button>
      </div>
    </form>
  )
}

function BackendStatusBar({
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

function codexWorkspacePath(provider: Provider): string {
  if (provider.kind !== 'codex-local') return ''
  return typeof provider.meta?.workspace_path === 'string' ? provider.meta.workspace_path : ''
}

const DEFAULT_CODEX_SETTINGS = {
  codex_model: '',
  codex_effort: 'low',
  codex_summary: 'none',
  codex_service_tier: '',
  codex_sandbox: 'read-only',
  codex_approval_policy: 'never',
  codex_prompt_mode: 'fast-edit',
} satisfies Partial<ProviderDraft>

type CodexSettingsDraft = Pick<
  ProviderDraft,
  | 'codex_model'
  | 'codex_effort'
  | 'codex_summary'
  | 'codex_service_tier'
  | 'codex_sandbox'
  | 'codex_approval_policy'
  | 'codex_prompt_mode'
>

function codexProviderSettings(provider: Provider): Partial<ProviderUpdate> {
  if (provider.kind !== 'codex-local') return {}
  return {
    codex_model: stringMeta(provider.meta, 'codex_model'),
    codex_effort: enumMeta(provider.meta, 'codex_effort', ['none', 'low', 'medium', 'high', 'xhigh'], 'low') as ProviderDraft['codex_effort'],
    codex_summary: enumMeta(provider.meta, 'codex_summary', ['none', 'auto', 'concise', 'detailed'], 'none') as ProviderDraft['codex_summary'],
    codex_service_tier: stringMeta(provider.meta, 'codex_service_tier'),
    codex_sandbox: enumMeta(provider.meta, 'codex_sandbox', ['read-only', 'workspace-write', 'danger-full-access'], 'read-only') as ProviderDraft['codex_sandbox'],
    codex_approval_policy: enumMeta(provider.meta, 'codex_approval_policy', ['never', 'untrusted', 'on-request', 'on-failure'], 'never') as ProviderDraft['codex_approval_policy'],
    codex_prompt_mode: enumMeta(provider.meta, 'codex_prompt_mode', ['fast-edit', 'full-agent'], 'fast-edit') as ProviderDraft['codex_prompt_mode'],
  }
}

function codexSettingsPatch(source: Partial<CodexSettingsDraft>): Partial<ProviderUpdate> {
  return {
    codex_model: source.codex_model?.trim() ?? '',
    codex_effort: source.codex_effort === 'minimal' ? 'low' : source.codex_effort ?? 'low',
    codex_summary: source.codex_summary ?? 'none',
    codex_service_tier: source.codex_service_tier?.trim() ?? '',
    codex_sandbox: source.codex_sandbox ?? 'read-only',
    codex_approval_policy: source.codex_approval_policy ?? 'never',
    codex_prompt_mode: source.codex_prompt_mode ?? 'fast-edit',
  }
}

function CodexSettingsFields({
  draft,
  modelOptions,
  modelLoading,
  onChange,
}: {
  draft: Partial<CodexSettingsDraft>
  modelOptions: ProviderModel[]
  modelLoading?: boolean
  onChange: (patch: Partial<CodexSettingsDraft>) => void
}) {
  const selectedModel = draft.codex_model ?? ''
  const selectedModelInOptions = !selectedModel || modelOptions.some((model) => model.id === selectedModel)
  return (
    <>
      <div className="form-row">
        <label>
          <span>Codex Model</span>
          <select
            value={selectedModel}
            onChange={(event) => onChange({ codex_model: event.target.value })}
          >
            <option value="">使用本机默认</option>
            {!selectedModelInOptions && (
              <option value={selectedModel}>当前已保存：{selectedModel}</option>
            )}
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {codexModelOptionLabel(model)}
              </option>
            ))}
            {modelOptions.length === 0 && (
              <option value="" disabled>
                {modelLoading ? '正在读取本机模型…' : '连接后自动加载模型'}
              </option>
            )}
          </select>
        </label>
        <label>
          <span>Prompt Mode</span>
          <select
            value={draft.codex_prompt_mode ?? 'fast-edit'}
            onChange={(event) => onChange({ codex_prompt_mode: event.target.value as ProviderDraft['codex_prompt_mode'] })}
          >
            <option value="fast-edit">快速编辑</option>
            <option value="full-agent">完整 Agent</option>
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          <span>Reasoning</span>
          <select
            value={draft.codex_effort ?? 'low'}
            onChange={(event) => onChange({ codex_effort: event.target.value as ProviderDraft['codex_effort'] })}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="none">none</option>
          </select>
        </label>
        <label>
          <span>Summary</span>
          <select
            value={draft.codex_summary ?? 'none'}
            onChange={(event) => onChange({ codex_summary: event.target.value as ProviderDraft['codex_summary'] })}
          >
            <option value="none">none</option>
            <option value="concise">concise</option>
            <option value="auto">auto</option>
            <option value="detailed">detailed</option>
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          <span>Sandbox</span>
          <select
            value={draft.codex_sandbox ?? 'read-only'}
            onChange={(event) => onChange({ codex_sandbox: event.target.value as ProviderDraft['codex_sandbox'] })}
          >
            <option value="read-only">read-only</option>
            <option value="workspace-write">workspace-write</option>
            <option value="danger-full-access">danger-full-access</option>
          </select>
        </label>
        <label>
          <span>Approval</span>
          <select
            value={draft.codex_approval_policy ?? 'never'}
            onChange={(event) => onChange({ codex_approval_policy: event.target.value as ProviderDraft['codex_approval_policy'] })}
          >
            <option value="never">never</option>
            <option value="on-request">on-request</option>
            <option value="on-failure">on-failure</option>
            <option value="untrusted">untrusted</option>
          </select>
        </label>
      </div>
      <label className="full">
        <span>Service Tier</span>
        <input
          value={draft.codex_service_tier ?? ''}
          onChange={(event) => onChange({ codex_service_tier: event.target.value })}
          placeholder="留空使用本机默认"
        />
      </label>
    </>
  )
}

function stringMeta(meta: Record<string, unknown>, key: string): string {
  const value = meta[key]
  return typeof value === 'string' ? value : ''
}

function codexModelOptionLabel(model: ProviderModel): string {
  const label = model.name || model.model || model.id
  return model.is_default || model.raw?.isDefault === true || model.raw?.is_default === true ? `${label}（默认）` : label
}

function realCodexModelOptions(models: ProviderModel[]): ProviderModel[] {
  return models.filter((model) => model.id !== 'codex' && model.model !== 'codex')
}

function enumMeta(meta: Record<string, unknown>, key: string, allowed: string[], fallback: string): string {
  const value = stringMeta(meta, key)
  return allowed.includes(value) ? value : fallback
}

function agentColor(kind: string): string {
  if (kind === 'codex-local') return '#111827'
  if (kind === 'native') return '#059669'
  if (kind === 'nanobot') return '#0ea5e9'
  if (kind.includes('chat')) return '#7c3aed'
  if (kind.includes('agent')) return '#059669'
  return '#2563eb'
}

function providerConsoleLabel(kind: Provider['kind']): string {
  if (kind === 'claude-direct') return 'Claude 控制台'
  if (kind === 'nanobot') return 'Nanobot 服务'
  if (kind === 'codex-local') return '本机 Codex'
  if (kind === 'native') return '原生 Agent Provider'
  return 'Dify 控制台'
}

function modelsFromProviderMeta(meta: Record<string, unknown>): ProviderModel[] {
  const models = meta.models
  if (Array.isArray(models)) {
    return models
      .map((item): ProviderModel | null => {
        if (typeof item === 'string') {
          return { id: item, name: item, description: '' }
        }
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const id = String(record.id ?? record.name ?? '').trim()
        if (!id) return null
        return {
          id,
          name: String(record.name ?? record.model ?? id),
          description: String(record.description ?? ''),
          model: typeof record.model === 'string' ? record.model : undefined,
          hidden: Boolean(record.hidden),
          is_default: Boolean(record.is_default),
          default_reasoning_effort: typeof record.default_reasoning_effort === 'string'
            ? record.default_reasoning_effort
            : undefined,
          supported_reasoning_efforts: Array.isArray(record.supported_reasoning_efforts)
            ? record.supported_reasoning_efforts.map((value) => String(value).trim()).filter(Boolean)
            : undefined,
          service_tiers: Array.isArray(record.service_tiers)
            ? record.service_tiers as ProviderModel['service_tiers']
            : undefined,
          default_service_tier: typeof record.default_service_tier === 'string'
            ? record.default_service_tier
            : undefined,
          raw: record.raw && typeof record.raw === 'object'
            ? record.raw as Record<string, unknown>
            : undefined,
        }
      })
      .filter((item): item is ProviderModel => item !== null)
  }
  const ids = meta.model_ids
  if (!Array.isArray(ids)) return []
  return ids
    .map((id) => String(id).trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id, description: '' }))
}

interface DisabledAgentsModalProps {
  workflows: CachedWorkflow[]
  onClose: () => void
  onAfterMutate: () => void
}

function DisabledAgentsModal({ workflows, onClose, onAfterMutate }: DisabledAgentsModalProps) {
  const enableWorkflow = useWorkflowStore((s) => s.enableWorkflow)
  const [busy, setBusy] = useState<string | null>(null)

  const handleEnable = async (workflowId: string, workflowName: string) => {
    if (!confirm(`激活 Agent「${workflowName}」？激活后将重新出现在 @mention 列表中。`)) return
    setBusy(workflowId)
    await enableWorkflow(workflowId)
    setBusy(null)
    onAfterMutate()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>已禁用的 Agent</h3>
          <button className="ghost-btn small" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {workflows.length === 0 ? (
            <div className="agent-empty-inline">没有已禁用的 Agent</div>
          ) : (
            <div className="agent-list">
              {workflows.map((wf) => (
                <div key={wf.id} className="agent-card disabled">
                  <div className="agent-avatar" style={{ background: agentColor(wf.kind) }}>
                    {wf.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="agent-info">
                    <strong>{wf.name}</strong>
                    <span>
                      {wf.kind}
                      {wf.description ? ` · ${wf.description}` : wf.external_id ? ` · ${wf.external_id}` : ''}
                    </span>
                  </div>
                  <button
                    className="tree-action-btn"
                    title="激活 Agent"
                    onClick={() => handleEnable(wf.id, wf.name)}
                    disabled={busy === wf.id}
                  >
                    {busy === wf.id ? <Loader2 size={12} className="spin" /> : <CheckCircle size={12} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

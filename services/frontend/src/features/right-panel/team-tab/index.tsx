/**
 * TeamTab — Agent 团队管理。
 *
 * UI 上每个"Agent"对应后端的一行 Provider（一个 endpoint + API key 组合就是
 * 一个 Agent）。同时显示从该 provider 同步出来的 cached workflows，让用户可
 * 以看到 Dify 那边到底有哪些 app。
 *
 * 这个文件只负责容器层：子标签切换、store 接线、以及把数据分发给 team-tab/
 * 下的各个面板组件。具体的渲染逻辑都拆到了同目录的子模块里。
 */

import { useEffect, useState } from 'react'
import { Download, Loader2, Plus, RefreshCw } from 'lucide-react'
import type {
  CachedWorkflow,
  LocalAgentHostPackageInfo,
  OfficialBadgeStyle,
  WorkflowDefinition,
  WorkflowDefinitionDraft,
} from '../../../services/backendApi'
import { nativeAgentApi } from '../../../services/backendApi'
import { bootstrapLocalAgentHostAuthFromPackageInfo } from '../../../services/localAgentHostAutoAuth'
import type { Selection } from '../../../types/editor'
import type { RunEvent, NodeStatus } from '../../../stores/workflowStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useProjectStore } from '../../../stores/projectStore'
import { useNativeAgentStore } from '../../../stores/nativeAgentStore'
import { trainingExportApi } from '../../../services/trainingExportApi'
import { WorkflowDefinitionsPanel } from '../WorkflowDefinitionsPanel'
import { OfficialBadgeStyleContext } from './badges'
import type { SubTab } from './constants'
import { DisabledAgentsModal } from './agent-cards'
import { LocalHostDiagnosticsPanel, LocalHostInstallPanel } from './diagnostics'
import { McpManagementPanel } from './McpManagementPanel'
import { SkillManagementPanel } from './SkillManagementPanel'
import { BackendStatusBar, ProviderBlock } from './providers'
import { ProviderForm } from './ProviderForm'

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
  const [localHostPackage, setLocalHostPackage] = useState<LocalAgentHostPackageInfo | null>(null)
  const [localHostPackageLoading, setLocalHostPackageLoading] = useState(false)
  const [localHostPackageError, setLocalHostPackageError] = useState<string | null>(null)
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

  useEffect(() => {
    if (subTab !== 'agents' || localHostPackage || localHostPackageLoading) return
    let cancelled = false
    setLocalHostPackageLoading(true)
    setLocalHostPackageError(null)
    nativeAgentApi.localAgentHost.info()
      .then((info) => {
        if (!cancelled) {
          bootstrapLocalAgentHostAuthFromPackageInfo(info)
          setLocalHostPackage(info)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLocalHostPackageError(err instanceof Error ? err.message : '无法读取 Local Host 安装包信息')
        }
      })
      .finally(() => {
        if (!cancelled) setLocalHostPackageLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [subTab, localHostPackage, localHostPackageLoading])

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
      await nativeAgentApi.localAgentHost.download(localHostPackage?.filename)
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

          <LocalHostInstallPanel
            packageInfo={localHostPackage}
            loading={localHostPackageLoading}
            error={localHostPackageError}
            downloading={localHostDownloading}
            onDownload={handleLocalHostDownload}
          />
          <LocalHostDiagnosticsPanel providers={providers} />

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

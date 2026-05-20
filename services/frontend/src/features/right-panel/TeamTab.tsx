/**
 * TeamTab — Agent 团队管理。
 *
 * UI 上每个"Agent"对应后端的一行 Provider（一个 endpoint + API key 组合就是
 * 一个 Agent）。同时显示从该 provider 同步出来的 cached workflows，让用户可
 * 以看到 Dify 那边到底有哪些 app。
 *
 * 后续 W7 会让这里直接挂"私聊"入口，所以预留 onChatWithAgent 钩子。
 */

import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  CheckCircle2,
  CircleAlert,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Trash2,
  Ban,
  CheckCircle,
  Download,
  FileText,
  FolderOpen,
  Pencil,
  X,
} from 'lucide-react'
import type {
  CachedWorkflow,
  NativeAgent,
  NativeAgentDraft,
  NativeAgentPatch,
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
import { BACKEND_BASE, getLocalServiceUrl } from '../../services/backendApi'
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

type SubTab = 'agents' | 'skills' | 'workflows'

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
  const nativeLoaded = useNativeAgentStore((s) => s.loaded)
  const nativeError = useNativeAgentStore((s) => s.error)
  const marketplaceError = useNativeAgentStore((s) => s.marketplaceError)
  const loadNativeAgents = useNativeAgentStore((s) => s.loadAll)
  const loadMarketplace = useNativeAgentStore((s) => s.loadMarketplace)
  const createSkill = useNativeAgentStore((s) => s.createSkill)
  const createRecipeSkill = useNativeAgentStore((s) => s.createRecipeSkill)
  const updateSkill = useNativeAgentStore((s) => s.updateSkill)
  const publishSkill = useNativeAgentStore((s) => s.publishSkill)
  const unpublishSkill = useNativeAgentStore((s) => s.unpublishSkill)
  const removeSkill = useNativeAgentStore((s) => s.removeSkill)
  const installMarketplaceSkill = useNativeAgentStore((s) => s.installMarketplaceSkill)
  const updateMarketplaceSkill = useNativeAgentStore((s) => s.updateMarketplaceSkill)
  const uninstallMarketplaceSkill = useNativeAgentStore((s) => s.uninstallMarketplaceSkill)

  const [subTab, setSubTab] = useState<SubTab>('agents')
  const [showForm, setShowForm] = useState(false)
  const [showDisabledModal, setShowDisabledModal] = useState(false)
  const [onlyTrainingCandidates, setOnlyTrainingCandidates] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) load()
  }, [loaded, load])

  useEffect(() => {
    if ((subTab === 'skills' || subTab === 'agents') && !nativeLoaded) void loadNativeAgents()
  }, [subTab, nativeLoaded, loadNativeAgents])

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

  return (
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
        <button
          className={subTab === 'workflows' ? 'active' : ''}
          onClick={() => setSubTab('workflows')}
        >
          工作流（{definitions.length}）
        </button>
      </div>

      {subTab === 'agents' && (
        <>
          <div className="tab-header-row">
            <span>Agent 团队：{activeCount} 个活跃 · {disabledCount} 个禁用</span>
            <div style={{ display: 'flex', gap: '8px' }}>
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
          onUpdateSkill={updateSkill}
          onPublishSkill={publishSkill}
          onUnpublishSkill={unpublishSkill}
          onRemoveSkill={removeSkill}
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
  })
  const [providerError, setProviderError] = useState<string | null>(null)
  const [showNativeForm, setShowNativeForm] = useState(false)
  const [modelOptions, setModelOptions] = useState<ProviderModel[]>([])
  const [modelError, setModelError] = useState<string | null>(null)

  const providerNativeAgents = nativeAgents.filter((agent) => agent.provider_id === provider.id)

  useEffect(() => {
    setProviderPatch({ name: provider.name, endpoint: provider.endpoint, api_key: '' })
  }, [provider.id, provider.name, provider.endpoint])

  useEffect(() => {
    if (provider.kind === 'native' && !nativeLoaded) void loadNativeAgents()
  }, [provider.kind, nativeLoaded, loadNativeAgents])

  useEffect(() => {
    if (provider.kind === 'native') {
      setModelOptions(modelsFromProviderMeta(provider.meta))
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
    const updated = await updateProvider(provider.id, patch)
    if (updated) {
      const synced = await probe(provider.id)
      if (synced?.kind === 'native') {
        setModelOptions(modelsFromProviderMeta(synced.meta))
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

  const modelInOptions = modelOptions.some((model) => model.id === draft.model)
  const effectiveModelMode = modelMode === 'select' && modelInOptions ? 'select' : 'custom'

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
                  <small>{skillPillLabel(skill)}</small>
                </label>
              )
            })}
          </div>
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
  onUpdateSkill: (id: string, patch: SkillPatch) => Promise<Skill | null>
  onPublishSkill: (id: string) => Promise<Skill | null>
  onUnpublishSkill: (id: string) => Promise<Skill | null>
  onRemoveSkill: (id: string) => Promise<boolean>
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showPrivateForm, setShowPrivateForm] = useState(false)
  const [showRecipeForm, setShowRecipeForm] = useState(false)
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null)
  const [marketSearch, setMarketSearch] = useState('')
  const [pendingShareIds, setPendingShareIds] = useState<Set<string>>(new Set())
  const privateSkills = skills.filter((skill) => skill.source === 'upload')
  const marketplaceInstalled = skills.filter((skill) => skill.source === 'marketplace')
  const customRecipeSkills = skills.filter((skill) => skill.source === 'custom')
  const filteredMarketplaceSkills = marketplaceSkills.filter((entry) => skillMarketMatches(entry, marketSearch))

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    await action()
    setBusyId(null)
  }

  return (
    <section className="skill-management-panel">
      <div className="tab-header-row">
        <span>Skill 管理：{skills.length} 个可用 · {marketplaceInstalled.length} 个市场 · {customRecipeSkills.length} 个自定义 · {privateSkills.length} 个私有</span>
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
                {skill.can_edit ? (
                  <button className="skill-name-button" type="button" onClick={() => setEditingSkill(skill)}>
                    {skillLabel(skill)}
                  </button>
                ) : (
                  <strong>{skillLabel(skill)}</strong>
                )}
                <span>{skill.description || '无描述'}</span>
              </div>
              <div className="skill-market-actions">
                <span className={`native-pill ${skillPillTone(skill)}`}>{skillPillLabel(skill, pendingShareIds.has(skill.id))}</span>
                <button
                  className="ghost-btn small danger"
                  type="button"
                  disabled={busyId === skill.id}
                  onClick={() => {
                    if (!confirm(`从本地 Skill 库移除「${skillLabel(skill)}」？`)) return
                    void run(skill.id, () => onRemoveSkill(skill.id))
                  }}
                >
                  删除
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
                    <span className={`native-pill ${entry.installed ? 'ok' : 'neutral'}`}>
                      {entry.installed ? '本地' : '市场'}
                    </span>
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
  if (skill.source === 'marketplace') return '市场'
  if (skill.source === 'custom') return '自定义 npx'
  if (skill.visibility === 'public') return pendingShare ? '共享·待更新' : '共享'
  return '私有'
}

function skillPillTone(skill: Skill): string {
  if (skill.visibility === 'public' || skill.source === 'bundled' || skill.source === 'marketplace') return 'ok'
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
  const [draft, setDraft] = useState<ProviderDraft>({
    name: '',
    kind: 'dify-local',
    endpoint: 'http://localhost:8080/v1',
    api_key: '',
    activate: true,
  })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const handleKindChange = (kind: ProviderDraft['kind']) => {
    setDraft((d) => ({
      ...d,
      kind,
      endpoint:
        kind === 'dify-cloud'
          ? 'https://api.dify.ai/v1'
          : kind === 'claude-direct'
            ? 'https://api.anthropic.com'
            : kind === 'native'
              ? 'https://api.openai.com/v1'
            : kind === 'nanobot'
              ? getLocalServiceUrl(8902)
              : 'http://localhost:8080/v1',
      api_key: kind === 'nanobot' && !d.api_key.trim() ? 'dummy' : d.api_key,
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    const filledDraft: ProviderDraft = {
      ...draft,
      api_key: draft.kind === 'nanobot' && !draft.api_key.trim() ? 'dummy' : draft.api_key,
    }
    if (!filledDraft.name.trim() || !filledDraft.endpoint.trim() || !filledDraft.api_key.trim()) {
      setFormError('名称 / endpoint / API key 都不能为空')
      return
    }
    setSubmitting(true)
    const result = await create(filledDraft)
    if (result) {
      await probe(result.id)
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
              ? getLocalServiceUrl(8902)
              : draft.kind === 'native'
                ? 'https://api.openai.com/v1'
                : 'http://localhost:8080/v1'
          }
        />
      </label>
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

function agentColor(kind: string): string {
  if (kind === 'native') return '#059669'
  if (kind === 'nanobot') return '#0ea5e9'
  if (kind.includes('chat')) return '#7c3aed'
  if (kind.includes('agent')) return '#059669'
  return '#2563eb'
}

function providerConsoleLabel(kind: Provider['kind']): string {
  if (kind === 'claude-direct') return 'Claude 控制台'
  if (kind === 'nanobot') return 'Nanobot 服务'
  if (kind === 'native') return '原生 Agent Provider'
  return 'Dify 控制台'
}

function modelsFromProviderMeta(meta: Record<string, unknown>): ProviderModel[] {
  const models = meta.models
  if (Array.isArray(models)) {
    return models
      .map((item) => {
        if (typeof item === 'string') {
          return { id: item, name: item, description: '' }
        }
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const id = String(record.id ?? record.name ?? '').trim()
        if (!id) return null
        return {
          id,
          name: String(record.name ?? id),
          description: String(record.description ?? ''),
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

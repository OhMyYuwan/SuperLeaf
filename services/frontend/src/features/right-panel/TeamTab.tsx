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
} from 'lucide-react'
import type {
  CachedWorkflow,
  Provider,
  ProviderDraft,
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

type SubTab = 'agents' | 'workflows'

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

  const [subTab, setSubTab] = useState<SubTab>('agents')
  const [showForm, setShowForm] = useState(false)
  const [showDisabledModal, setShowDisabledModal] = useState(false)
  const [onlyTrainingCandidates, setOnlyTrainingCandidates] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) load()
  }, [loaded, load])

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
  const remove = useSettingsStore((s) => s.remove)
  const activate = useSettingsStore((s) => s.activate)
  const [busy, setBusy] = useState<'probe' | 'remove' | 'activate' | null>(null)
  const [statsByWorkflow, setStatsByWorkflow] = useState<Record<string, AgentStat>>({})

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
    await probe(provider.id)
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

      <div className="agent-list">
        {!workflowsLoaded && <div className="agent-empty-inline">加载中…</div>}
        {workflowsLoaded && workflows.length === 0 && (
          <div className="agent-empty-inline">
            该供应商下还没有 Agent。在 {providerConsoleLabel(provider.kind)} 创建后点上方刷新。
          </div>
        )}
        {workflows.filter((w) => !w.is_disabled).map((wf) => (
          <AgentCard
            key={wf.id}
            workflow={wf}
            stat={statsByWorkflow[wf.id] ?? null}
            onChatWithAgent={onChatWithAgent}
            onAfterMutate={onAfterMutate}
          />
        ))}
      </div>
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
    setSubmitting(false)
    if (result) {
      onClose()
      onCreated()
    } else {
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
          </select>
        </label>
      </div>
      <label className="full">
        <span>Endpoint</span>
        <input
          value={draft.endpoint}
          onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
          placeholder={draft.kind === 'nanobot' ? getLocalServiceUrl(8902) : 'http://localhost:8080/v1'}
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
  if (kind === 'nanobot') return '#0ea5e9'
  if (kind.includes('chat')) return '#7c3aed'
  if (kind.includes('agent')) return '#059669'
  return '#2563eb'
}

function providerConsoleLabel(kind: Provider['kind']): string {
  if (kind === 'claude-direct') return 'Claude 控制台'
  if (kind === 'nanobot') return 'Nanobot 服务'
  return 'Dify 控制台'
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

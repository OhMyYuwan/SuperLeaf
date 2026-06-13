/**
 * Agent card components: stats / quality rows, the cached-workflow AgentCard,
 * the NativeAgentCard, and the disabled-agents modal.
 */

import { useMemo, useState } from 'react'
import { Ban, CheckCircle, Loader2, MessageSquare, Pencil, Trash2 } from 'lucide-react'
import type {
  CachedWorkflow,
  NativeAgent,
  NativeAgentPatch,
  ProviderModel,
} from '../../../services/backendApi'
import type { AgentStat } from '../../../services/statsApi'
import { computeAgentQuality } from '../../../services/agentQuality'
import { useAnnotationStore } from '../../../stores/annotationStore'
import { useNativeAgentStore } from '../../../stores/nativeAgentStore'
import { useWorkflowStore } from '../../../stores/workflowStore'
import { agentColor } from './agent-presentation'
import { NativeAgentForm } from './NativeAgentForm'

export function AgentStatsRow({ stat }: { stat: AgentStat | null }) {
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

export function AgentQualityRow({ workflowId }: { workflowId: string }) {
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

interface AgentCardProps {
  workflow: CachedWorkflow
  stat: AgentStat | null
  onChatWithAgent?: (workflow: CachedWorkflow) => void
  onAfterMutate: () => void
}

export function AgentCard({ workflow, stat, onChatWithAgent, onAfterMutate }: AgentCardProps) {
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

export function NativeAgentCard({ agent, modelOptions, modelError, onUpdate, onRemove, onAfterMutate }: NativeAgentCardProps) {
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

interface DisabledAgentsModalProps {
  workflows: CachedWorkflow[]
  onClose: () => void
  onAfterMutate: () => void
}

export function DisabledAgentsModal({ workflows, onClose, onAfterMutate }: DisabledAgentsModalProps) {
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

/**
 * WorkflowTab — instruction composer + one card per cached workflow.
 *
 * Self-manages only the instruction textarea state. Runs/events are owned by
 * workflowStore; the parent passes down the relevant slice.
 *
 * Now also supports workflow definitions (orchestrated multi-agent workflows).
 */

import { useState } from 'react'
import type { CachedWorkflow, WorkflowDefinition } from '../../services/backendApi'
import type { Selection } from '../../types/editor'
import type { RunEvent, NodeStatus } from '../../stores/workflowStore'
import { WorkflowDefinitionEditor } from './WorkflowDefinitionEditor'

interface WorkflowTabProps {
  workflows: CachedWorkflow[]
  definitions: WorkflowDefinition[]
  activeSelection: Selection | null
  runningMap: Record<string, boolean>
  eventsMap: Record<string, RunEvent[]>
  nodeStatusesMap: Record<string, NodeStatus[]>
  currentRoundMap: Record<string, number>
  maxRoundsMap: Record<string, number>
  onRun: (workflowId: string, instruction: string) => void
  onRunDefinition: (definitionId: string, instruction: string) => void
  onCreateDefinition: (draft: any) => Promise<void>
  onUpdateDefinition: (id: string, draft: any) => Promise<void>
  onDeleteDefinition: (id: string) => Promise<void>
}

export function WorkflowTab({
  workflows,
  definitions,
  activeSelection,
  runningMap,
  eventsMap,
  nodeStatusesMap,
  currentRoundMap,
  maxRoundsMap,
  onRun,
  onRunDefinition,
  onCreateDefinition,
  onUpdateDefinition,
  onDeleteDefinition,
}: WorkflowTabProps) {
  const [instruction, setInstruction] = useState('')
  const [showEditor, setShowEditor] = useState(false)
  const [editingDefinition, setEditingDefinition] = useState<WorkflowDefinition | undefined>()
  const [activeTab, setActiveTab] = useState<'workflows' | 'definitions'>('workflows')

  const handleCreateDefinition = async (draft: any) => {
    await onCreateDefinition(draft)
    setShowEditor(false)
  }

  const handleUpdateDefinition = async (draft: any) => {
    if (editingDefinition) {
      await onUpdateDefinition(editingDefinition.id, draft)
      setShowEditor(false)
      setEditingDefinition(undefined)
    }
  }

  const handleEditDefinition = (def: WorkflowDefinition) => {
    setEditingDefinition(def)
    setShowEditor(true)
  }

  const handleCancelEditor = () => {
    setShowEditor(false)
    setEditingDefinition(undefined)
  }

  if (showEditor) {
    return (
      <WorkflowDefinitionEditor
        definition={editingDefinition}
        onSave={editingDefinition ? handleUpdateDefinition : handleCreateDefinition}
        onCancel={handleCancelEditor}
      />
    )
  }

  return (
    <div className="tab-content-wrapper">
      <div className="tab-header-row">
        <div className="tab-switcher">
          <button
            className={activeTab === 'workflows' ? 'active' : ''}
            onClick={() => setActiveTab('workflows')}
          >
            单 Agent
          </button>
          <button
            className={activeTab === 'definitions' ? 'active' : ''}
            onClick={() => setActiveTab('definitions')}
          >
            编排 Workflow
          </button>
        </div>
        {activeTab === 'definitions' && (
          <button className="primary-btn" onClick={() => setShowEditor(true)}>
            + 创建 Workflow
          </button>
        )}
      </div>

      {!activeSelection && <div className="tab-empty">先在编辑器里选中一段文字。</div>}

      {activeSelection && (
        <div className="run-instruction-block">
          <label className="run-instruction-label">给 Agent 的指令（可选）</label>
          <textarea
            className="run-instruction-input"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="例如：请润色 / 压缩到 50 字 / 检查逻辑 / 调整段落结构…"
            rows={2}
          />
          <div className="run-instruction-presets">
            {PRESETS.map((p) => (
              <button
                key={p}
                className="preset-chip"
                type="button"
                onClick={() => setInstruction(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'workflows' && (
        <div className="workflow-runs">
          {workflows.map((wf) => {
            const running = !!runningMap[wf.id]
            const events = eventsMap[wf.id] ?? []
            return (
              <div key={wf.id} className="workflow-run-card">
                <div className="workflow-run-head">
                  <div>
                    <strong>{wf.name}</strong>
                    <span className="workflow-run-kind"> · {workflowKindLabel(wf.kind)}</span>
                  </div>
                  <button
                    className="primary-btn run-btn"
                    onClick={() => onRun(wf.id, instruction)}
                    disabled={running}
                  >
                    {running ? '运行中…' : '▶ 运行'}
                  </button>
                </div>
                {events.length > 0 && (
                  <ul className="run-events">
                    {events.slice(-6).map((evt, i) => (
                      <li key={i} className={`run-event ${evt.kind.replaceAll('.', '-')}`}>
                        <span className="event-kind">{eventLabel(evt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}

      {activeTab === 'definitions' && (
        <div className="workflow-definitions">
          {definitions.map((def) => {
            const running = !!runningMap[def.id]
            const events = eventsMap[def.id] ?? []
            const nodeStatuses = nodeStatusesMap[def.id] ?? []
            const currentRound = currentRoundMap[def.id] ?? 0
            const maxRounds = maxRoundsMap[def.id] ?? 0
            return (
              <div key={def.id} className="workflow-definition-card">
                <div className="workflow-run-head">
                  <div>
                    <strong>{def.name}</strong>
                    <span className="workflow-run-kind"> · {def.execution_mode}</span>
                    {def.execution_mode === 'roundtable' && maxRounds > 0 && (
                      <span className="round-indicator"> · 第 {currentRound}/{maxRounds} 轮</span>
                    )}
                  </div>
                  <div className="definition-actions">
                    <button
                      className="secondary-btn"
                      onClick={() => handleEditDefinition(def)}
                      disabled={running}
                    >
                      编辑
                    </button>
                    <button
                      className="danger-btn"
                      onClick={() => onDeleteDefinition(def.id)}
                      disabled={running}
                    >
                      删除
                    </button>
                    <button
                      className="primary-btn run-btn"
                      onClick={() => onRunDefinition(def.id, instruction)}
                      disabled={running}
                    >
                      {running ? '运行中…' : '▶ 运行'}
                    </button>
                  </div>
                </div>
                {def.description && (
                  <div className="definition-description">{def.description}</div>
                )}
                {nodeStatuses.length > 0 && (
                  <div className="node-statuses">
                    <div className="node-statuses-header">节点状态：</div>
                    <ul className="node-status-list">
                      {nodeStatuses.map((node) => (
                        <li key={node.nodeId} className={`node-status ${node.status}`}>
                          <span className="node-id">{node.nodeId}</span>
                          <span className="node-status-badge">{nodeStatusLabel(node.status)}</span>
                          {node.error && <span className="node-error">{node.error}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {events.length > 0 && (
                  <ul className="run-events">
                    {events.slice(-6).map((evt, i) => (
                      <li key={i} className={`run-event ${evt.kind.replaceAll('.', '-')}`}>
                        <span className="event-kind">{eventLabel(evt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const PRESETS = [
  '润色这段文字',
  '压缩到 50 字以内',
  '检查论证逻辑',
  '调整段落结构',
  '改写得更学术',
  '检查引用与事实',
]

interface EventLike {
  kind: string
  payload: unknown
}

function eventLabel(evt: EventLike): string {
  if (evt.kind === 'ylw.run.started') return '已提交到 Dify / Nanobot'
  if (evt.kind === 'ylw.run.finished') return '完成 ✓'
  if (evt.kind === 'ylw.run.failed') {
    const p = evt.payload as { error?: string } | undefined
    return `失败: ${p?.error ?? ''}`
  }
  if (evt.kind === 'workflow.started') return 'Workflow 开始'
  if (evt.kind === 'workflow.completed') return 'Workflow 完成 ✓'
  if (evt.kind === 'workflow.merged') return '结果已合并'
  if (evt.kind === 'node.started') {
    const p = evt.payload as { nodeId?: string } | undefined
    return `节点 ${p?.nodeId ?? ''} 开始`
  }
  if (evt.kind === 'node.completed') {
    const p = evt.payload as { nodeId?: string } | undefined
    return `节点 ${p?.nodeId ?? ''} 完成 ✓`
  }
  if (evt.kind === 'node.failed') {
    const p = evt.payload as { nodeId?: string } | undefined
    return `节点 ${p?.nodeId ?? ''} 失败 ✗`
  }
  if (evt.kind === 'round.started') {
    const p = evt.payload as { round?: number } | undefined
    return `第 ${p?.round ?? ''} 轮开始`
  }
  if (evt.kind === 'round.completed') {
    const p = evt.payload as { round?: number } | undefined
    return `第 ${p?.round ?? ''} 轮完成`
  }
  if (evt.kind === 'roundtable.converged') return 'Roundtable 收敛 ✓'
  if (evt.kind === 'nanobot') return 'Nanobot 流式事件'
  const p = evt.payload as { event?: string } | undefined
  return p?.event ?? 'dify 事件'
}

function workflowKindLabel(kind: string): string {
  if (kind === 'nanobot') return 'Nanobot'
  if (kind === 'workflow') return 'Dify workflow'
  if (kind === 'chatflow') return 'Dify chatflow'
  if (kind === 'agent-chat') return 'Dify agent-chat'
  return kind
}

function nodeStatusLabel(status: string): string {
  if (status === 'pending') return '等待中'
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成 ✓'
  if (status === 'failed') return '失败 ✗'
  return status
}

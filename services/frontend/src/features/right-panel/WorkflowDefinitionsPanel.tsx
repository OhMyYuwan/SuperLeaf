/**
 * WorkflowDefinitionsPanel — orchestrated workflow list, reused inside TeamTab.
 *
 * Extracted from WorkflowTab so the "团队管理" tab can host both Agents and
 * orchestrated workflows side by side. Handles the instruction composer, the
 * per-definition run card, health check, and the embedded editor.
 */

import { useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { http } from '../../services/backendApi/client'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type {
  CachedWorkflow,
  WorkflowDefinition,
  WorkflowDefinitionDraft,
  WorkflowGraph,
} from '../../services/backendApi'
import type { Selection } from '../../types/editor'
import type { RunEvent, NodeStatus } from '../../stores/workflowStore'
import { WorkflowDefinitionEditor } from './WorkflowDefinitionEditor'
import { inspectDefinition, type DefinitionHealthReport } from './workflow-canvas/health'
import { WORKFLOW_TEMPLATES, cloneTemplate, isBackendTemplate, getBackendTemplateId, type WorkflowTemplate } from './templates'

interface WorkflowDefinitionsPanelProps {
  workflows: CachedWorkflow[]
  definitions: WorkflowDefinition[]
  activeSelection: Selection | null
  runningMap: Record<string, boolean>
  eventsMap: Record<string, RunEvent[]>
  nodeStatusesMap: Record<string, NodeStatus[]>
  currentRoundMap: Record<string, number>
  maxRoundsMap: Record<string, number>
  onRunDefinition: (definitionId: string, instruction: string) => void
  onTestDefinition: (definitionId: string, prompt: string) => void
  onCreateDefinition: (draft: WorkflowDefinitionDraft) => Promise<WorkflowDefinition | void>
  onUpdateDefinition: (id: string, draft: WorkflowDefinitionDraft) => Promise<WorkflowDefinition | void>
  onDeleteDefinition: (id: string) => Promise<void>
}

const PRESETS = [
  '润色这段文字',
  '压缩到 50 字以内',
  '检查论证逻辑',
  '调整段落结构',
  '改写得更学术',
  '检查引用与事实',
]

export function WorkflowDefinitionsPanel({
  workflows,
  definitions,
  activeSelection,
  runningMap,
  eventsMap,
  nodeStatusesMap,
  currentRoundMap,
  maxRoundsMap,
  onRunDefinition,
  onTestDefinition,
  onCreateDefinition,
  onUpdateDefinition,
  onDeleteDefinition,
}: WorkflowDefinitionsPanelProps) {
  const [instruction, setInstruction] = useState('')
  const [showEditor, setShowEditor] = useState(false)
  const [editingDefinition, setEditingDefinition] = useState<WorkflowDefinition | undefined>()
  const [draftFromTemplate, setDraftFromTemplate] = useState<WorkflowDefinitionDraft | undefined>()
  const currentProjectId = useProjectStore((s) => s.currentProjectId)

  const handleCreateDefinition = async (draft: WorkflowDefinitionDraft) => {
    const created = await onCreateDefinition(draft)
    if (created) {
      setEditingDefinition(created)
      setDraftFromTemplate(undefined)
    }
    setShowEditor(true)
    return created
  }
  const handleUpdateDefinition = async (draft: WorkflowDefinitionDraft) => {
    if (editingDefinition) {
      const updated = await onUpdateDefinition(editingDefinition.id, draft)
      if (updated) {
        setEditingDefinition(updated)
      }
      setShowEditor(true)
      return updated
    }
    setShowEditor(true)
    return undefined
  }
  const handleEditDefinition = (def: WorkflowDefinition) => {
    setEditingDefinition(def)
    setDraftFromTemplate(undefined)
    setShowEditor(true)
  }
  const handleCancelEditor = () => {
    setShowEditor(false)
    setEditingDefinition(undefined)
    setDraftFromTemplate(undefined)
  }
  const handleImportTemplate = (tpl: WorkflowTemplate) => {
    if (isBackendTemplate(tpl.id)) {
      // Backend template: install Skills first, then open editor with graph draft
      const backendId = getBackendTemplateId(tpl.id)
      if (!backendId || !currentProjectId) return
      http<{
        installed_skills: string[]
        graph_template: WorkflowGraph
        template_name: string
        template_description: string
      }>(`/api/workflow-templates/${backendId}/prepare`, {
        method: 'POST',
        body: JSON.stringify({ project_id: currentProjectId }),
      }).then((result) => {
        // Build a draft from the returned graph template
        const draft: WorkflowDefinitionDraft = {
          name: result.template_name,
          description: result.template_description,
          execution_mode: 'graph',
          graph: result.graph_template,
          config: { max_rounds: 3, provider: {} },
        }
        setEditingDefinition(undefined)
        setDraftFromTemplate(draft)
        setShowEditor(true)
      }).catch((e: any) => {
        alert(`创建失败: ${e.message || e}`)
      })
      return
    }
    // Local template: clone draft and open editor
    const draft = cloneTemplate(tpl.id)
    if (!draft) return
    setEditingDefinition(undefined)
    setDraftFromTemplate(draft)
    setShowEditor(true)
  }

  if (showEditor) {
    return (
      <WorkflowDefinitionEditor
        definition={editingDefinition}
        initialDraft={draftFromTemplate}
        onSave={editingDefinition ? handleUpdateDefinition : handleCreateDefinition}
        onCancel={handleCancelEditor}
        onTestDefinition={onTestDefinition}
        testRunning={editingDefinition ? !!runningMap[editingDefinition.id] : false}
        testEvents={editingDefinition ? eventsMap[editingDefinition.id] ?? [] : []}
        testNodeStatuses={editingDefinition ? nodeStatusesMap[editingDefinition.id] ?? [] : []}
      />
    )
  }

  return (
    <>
      <div className="tab-header-row">
        <span>编排 Workflow：{definitions.length} 个</span>
        <div className="definition-header-actions">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="secondary-btn">
                从模板新建 ▾
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="conversation-dropdown" sideOffset={4} align="end">
                <div className="conversation-dropdown-header">
                  <span>Workflow 模板</span>
                </div>
                {WORKFLOW_TEMPLATES.map((tpl) => (
                  <DropdownMenu.Item
                    key={tpl.id}
                    className="conversation-dropdown-item"
                    onSelect={() => handleImportTemplate(tpl)}
                  >
                    <div className="conversation-dropdown-item-content">
                      <div className="conversation-dropdown-item-header">
                        <span className="conversation-dropdown-title">{tpl.label}</span>
                      </div>
                      <div className="conversation-dropdown-preview">{tpl.description}</div>
                    </div>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button className="primary-btn" onClick={() => setShowEditor(true)}>
            <span>+</span> 创建 Workflow
          </button>
        </div>
      </div>

      {!activeSelection && <div className="tab-empty">先在编辑器里选中一段文字再运行。</div>}

      {activeSelection && (
        <div className="run-instruction-block">
          <label className="run-instruction-label">给 Workflow 的指令（可选）</label>
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

      {definitions.length === 0 && (
        <div className="tab-empty">
          还没有编排 Workflow。点右上角 <strong>创建 Workflow</strong> 开始编排。
        </div>
      )}

      <div className="workflow-definitions">
        {definitions.map((def) => {
          const running = !!runningMap[def.id]
          const events = eventsMap[def.id] ?? []
          const nodeStatuses = nodeStatusesMap[def.id] ?? []
          const currentRound = currentRoundMap[def.id] ?? 0
          const maxRounds = maxRoundsMap[def.id] ?? 0
          const health: DefinitionHealthReport = inspectDefinition(def, workflows)
          const isDegraded = health.status === 'degraded'
          const isMissing = health.status === 'missing'
          const runBlocked = isDegraded || isMissing
          return (
            <div
              key={def.id}
              className={`workflow-definition-card${
                isDegraded || isMissing ? ' is-degraded' : ''
              }`}
            >
              <div className="workflow-run-head">
                <div>
                  <strong>{def.name}</strong>
                  <span className="workflow-run-kind"> · {def.execution_mode}</span>
                  {def.execution_mode === 'roundtable' && maxRounds > 0 && (
                    <span className="round-indicator"> · 第 {currentRound}/{maxRounds} 轮</span>
                  )}
                  {isDegraded && (
                    <span className="workflow-health-badge">
                      ⚠ {health.issues.length} 个节点不可用
                    </span>
                  )}
                  {isMissing && (
                    <span className="workflow-health-badge">
                      ⚠ 缺少 {health.missingBoundary.join(' / ')} 节点
                    </span>
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
                    disabled={running || runBlocked}
                    title={
                      isDegraded
                        ? '存在被禁用或缺失的 Agent，请先编辑 workflow'
                        : isMissing
                        ? `缺少 ${health.missingBoundary.join(' / ')} 节点，请先在编辑器中添加`
                        : undefined
                    }
                  >
                    {running ? '运行中…' : '▶ 运行'}
                  </button>
                </div>
              </div>
              {def.description && (
                <div className="definition-description">{def.description}</div>
              )}
              {isMissing && (
                <div className="workflow-health-detail">
                  Workflow 缺少必要的边界节点：
                  <ul>
                    {health.missingBoundary.map((kind) => (
                      <li key={kind}>
                        <code>{kind}</code> 节点 —— 用于
                        {kind === 'input' ? '声明输入（选中文本、指令、引用文件）' : '声明最终输出的格式'}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {isDegraded && (
                <div className="workflow-health-detail">
                  以下节点的 Agent 配置不可用，需要进入编辑器修改后才能运行：
                  <ul>
                    {health.issues.map((iss) => (
                      <li key={iss.nodeId}>
                        <code>{iss.nodeId}</code>
                        {' → '}
                        <code>
                          {iss.agentId
                            ? `${iss.agentId.slice(0, 12)}${iss.agentId.length > 12 ? '…' : ''}`
                            : '未选择 Agent'}
                        </code>
                        {issueReasonLabel(iss.reason)}
                      </li>
                    ))}
                  </ul>
                </div>
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
    </>
  )
}

interface EventLike {
  kind: string
  payload: unknown
}

function issueReasonLabel(reason: string): string {
  if (reason === 'unconfigured') return '（未配置）'
  if (reason === 'disabled') return '（已禁用）'
  return '（已删除）'
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

function nodeStatusLabel(status: string): string {
  if (status === 'pending') return '等待中'
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成 ✓'
  if (status === 'failed') return '失败 ✗'
  return status
}

/**
 * WorkflowTab — instruction composer + one card per cached workflow.
 *
 * Self-manages only the instruction textarea state. Runs/events are owned by
 * workflowStore; the parent passes down the relevant slice.
 */

import { useState } from 'react'
import type { CachedWorkflow } from '../../services/backendApi'
import type { Selection } from '../../types/editor'
import type { RunEvent } from '../../stores/workflowStore'

interface WorkflowTabProps {
  workflows: CachedWorkflow[]
  activeSelection: Selection | null
  runningMap: Record<string, boolean>
  eventsMap: Record<string, RunEvent[]>
  onRun: (workflowId: string, instruction: string) => void
}

export function WorkflowTab({
  workflows,
  activeSelection,
  runningMap,
  eventsMap,
  onRun,
}: WorkflowTabProps) {
  const [instruction, setInstruction] = useState('')

  return (
    <div className="tab-content-wrapper">
      <div className="tab-header-row">
        <span>选中文字、写下指令，再选择 workflow 运行</span>
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

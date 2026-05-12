/**
 * RunHistoryTab — persisted list of workflow runs.
 *
 * Reads the `runHistory` slice of the workflow store. Auto-reloads:
 *   - on mount
 *   - whenever any run flips from running -> idle (so a freshly-completed
 *     run shows up without manual refresh)
 *
 * Filtering: if `documentId` is provided we narrow to runs for that doc.
 * Click on a row opens an inline detail view showing outputs + error.
 */

import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, Trash2, ChevronRight, ChevronDown, Loader2 } from 'lucide-react'
import { useWorkflowStore } from '../../stores/workflowStore'
import type { CachedWorkflow, WorkflowRun } from '../../services/backendApi'

interface RunHistoryTabProps {
  workflows: CachedWorkflow[]
  documentId: string | null
  onJumpToRange?: (range: { from: number; to: number }) => void
}

export function RunHistoryTab({ workflows, documentId, onJumpToRange }: RunHistoryTabProps) {
  const [filterDoc, setFilterDoc] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const runHistory = useWorkflowStore((s) => s.runHistory)
  const loading = useWorkflowStore((s) => s.historyLoading)
  const error = useWorkflowStore((s) => s.historyError)
  const running = useWorkflowStore((s) => s.running)
  const loadHistory = useWorkflowStore((s) => s.loadHistory)
  const deleteRun = useWorkflowStore((s) => s.deleteRun)

  const workflowsById = useMemo(
    () => Object.fromEntries(workflows.map((w) => [w.id, w])),
    [workflows],
  )

  const anyRunning = useMemo(
    () => Object.values(running).some(Boolean),
    [running],
  )

  // Reload on mount, on filter change, and when an in-flight run finishes.
  // We track previous "anyRunning" to fire only on the falling edge.
  const reload = () => {
    loadHistory(filterDoc && documentId ? { documentId } : undefined)
  }
  useEffect(reload, [filterDoc, documentId])

  useEffect(() => {
    if (!anyRunning) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyRunning])

  const handleDelete = async (e: React.MouseEvent, runId: string) => {
    e.stopPropagation()
    if (!confirm('删除这条运行历史？')) return
    await deleteRun(runId)
  }

  const handleJump = (e: React.MouseEvent, run: WorkflowRun) => {
    e.stopPropagation()
    if (run.document_id !== documentId) {
      alert('该运行对应的不是当前文档。')
      return
    }
    onJumpToRange?.({ from: run.range_start, to: run.range_end })
  }

  return (
    <div className="tab-content-wrapper">
      <div className="tab-header-row">
        <span>运行历史：{runHistory.length} 条</span>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <label className="run-filter-label">
            <input
              type="checkbox"
              checked={filterDoc}
              onChange={(e) => setFilterDoc(e.target.checked)}
            />
            仅当前文档
          </label>
          <button className="small-btn" onClick={reload} disabled={loading}>
            {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        </span>
      </div>

      {error && <div className="tab-error">{error}</div>}

      {!loading && runHistory.length === 0 && (
        <div className="tab-empty">
          {filterDoc && documentId
            ? '当前文档暂无运行记录。先去工作流 tab 跑一次试试。'
            : '尚无任何运行记录。'}
        </div>
      )}

      <div className="run-history-list">
        {runHistory.map((run) => {
          const wf = workflowsById[run.workflow_id]
          const isOpen = expandedId === run.id
          return (
            <div key={run.id} className={`run-history-item status-${run.status}`}>
              <div
                className="run-history-row"
                onClick={() => setExpandedId(isOpen ? null : run.id)}
              >
                <span className="run-history-toggle">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
                <span className="run-history-name">
                  {wf ? `${wf.name}·${wf.id.slice(0, 8)}` : run.workflow_id.slice(0, 8)}
                </span>
                <span className={`run-history-status ${run.status}`}>{statusLabel(run.status)}</span>
                <span className="run-history-time">{formatTime(run.started_at)}</span>
                <span className="run-history-actions">
                  {run.document_id === documentId && (
                    <button
                      className="tree-action-btn"
                      title="跳转到原选区"
                      onClick={(e) => handleJump(e, run)}
                    >
                      ↗
                    </button>
                  )}
                  <button
                    className="tree-action-btn"
                    title="删除"
                    onClick={(e) => handleDelete(e, run.id)}
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              </div>
              {isOpen && <RunDetail run={run} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RunDetail({ run }: { run: WorkflowRun }) {
  const duration = run.finished_at
    ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
    : null

  return (
    <div className="run-history-detail">
      <div className="run-detail-meta">
        <span>文档：{run.document_id.slice(0, 8)}</span>
        <span>·</span>
        <span>选区：[{run.range_start}, {run.range_end}]</span>
        {duration !== null && (
          <>
            <span>·</span>
            <span>耗时 {(duration / 1000).toFixed(1)}s</span>
          </>
        )}
        {run.external_run_id && (
          <>
            <span>·</span>
            <span title={run.external_run_id}>Dify {run.external_run_id.slice(0, 8)}</span>
          </>
        )}
      </div>
      {run.error && <div className="run-detail-error">{run.error}</div>}
      {Object.keys(run.outputs).length > 0 && (
        <pre className="run-detail-outputs">{JSON.stringify(run.outputs, null, 2)}</pre>
      )}
    </div>
  )
}

function statusLabel(status: string): string {
  if (status === 'running') return '执行中'
  if (status === 'completed') return '完成'
  if (status === 'failed') return '失败'
  return status
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString()
  return d.toLocaleString()
}

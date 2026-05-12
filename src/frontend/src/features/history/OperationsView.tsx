/**
 * OperationsView — append-only audit log for the active document.
 *
 * Renders rows newest-first. Each row shows: type chip, time, payload
 * preview (annotation excerpt or version number), actor.
 */

import { useEffect } from 'react'
import { RefreshCw, Loader2, Check, X, RotateCcw, Tag } from 'lucide-react'

import { useHistoryStore } from '../../stores/historyStore'
import type { Operation, OperationType } from '../../services/operationApi'

interface OperationsViewProps {
  documentId: string
}

const TYPE_LABEL: Record<OperationType, string> = {
  accept_suggestion: '采纳建议',
  reject_suggestion: '拒绝建议',
  restore: '回滚版本',
  label_add: '添加标签',
  label_remove: '删除标签',
}

const TYPE_CLASS: Record<OperationType, string> = {
  accept_suggestion: 'op-accept',
  reject_suggestion: 'op-reject',
  restore: 'op-restore',
  label_add: 'op-label-add',
  label_remove: 'op-label-remove',
}

function iconFor(type: OperationType) {
  switch (type) {
    case 'accept_suggestion':
      return <Check size={12} />
    case 'reject_suggestion':
      return <X size={12} />
    case 'restore':
      return <RotateCcw size={12} />
    case 'label_add':
    case 'label_remove':
      return <Tag size={12} />
  }
}

export function OperationsView({ documentId }: OperationsViewProps) {
  const operationsMap = useHistoryStore((s) => s.operations)
  const opsLoading = useHistoryStore((s) => s.opsLoading)
  const opsError = useHistoryStore((s) => s.opsError)
  const loadOperations = useHistoryStore((s) => s.loadOperations)

  const ops = operationsMap[documentId] ?? []
  const loading = opsLoading[documentId] ?? false
  const error = opsError[documentId] ?? null

  useEffect(() => {
    loadOperations(documentId)
  }, [documentId, loadOperations])

  return (
    <>
      <div className="tab-header-row">
        <span>操作日志：{ops.length} 条（最近 50 条）</span>
        <button
          className="small-btn"
          onClick={() => loadOperations(documentId)}
          disabled={loading}
        >
          {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 刷新
        </button>
      </div>

      {error && <div className="tab-error">{error}</div>}

      {!loading && ops.length === 0 && (
        <div className="tab-empty">暂无操作记录。采纳/拒绝建议、回滚、标签变更都会被记录在这里。</div>
      )}

      <ul className="operations-list">
        {ops.map((op) => (
          <li key={op.id} className="operation-item">
            <span className={`operation-type ${TYPE_CLASS[op.type]}`}>
              {iconFor(op.type)} {TYPE_LABEL[op.type] ?? op.type}
            </span>
            <span className="operation-time">{formatTime(op.created_at)}</span>
            <div className="operation-detail">{summarize(op)}</div>
            {op.actor && <span className="operation-actor">{op.actor.slice(0, 8)}</span>}
          </li>
        ))}
      </ul>
    </>
  )
}

function summarize(op: Operation): string {
  const p = op.payload as Record<string, unknown>
  switch (op.type) {
    case 'accept_suggestion':
    case 'reject_suggestion': {
      const agent = (p.agent_name as string) ?? 'Agent'
      const excerpt = (p.target_text_excerpt as string) ?? ''
      return excerpt ? `${agent} · "${truncate(excerpt, 60)}"` : agent
    }
    case 'restore': {
      const v = p.version
      return typeof v === 'number' ? `恢复至 v${v}` : '恢复'
    }
    case 'label_add':
    case 'label_remove': {
      const v = p.version
      const text = (p.text as string) ?? ''
      const head = typeof v === 'number' ? `v${v}` : ''
      return text ? `${head} · "${truncate(text, 40)}"` : head
    }
    default:
      return ''
  }
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const delta = Date.now() - d.getTime()
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (delta < min) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / min)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

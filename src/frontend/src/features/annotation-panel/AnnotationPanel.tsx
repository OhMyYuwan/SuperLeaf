/**
 * AnnotationPanel — right-column list of cards, one per Annotation /
 * Suggestion / Risk produced by Dify. Each card supports three actions:
 *
 *   accept   — applies the suggestion (or marks the card resolved) and writes
 *              back to documentStore.content.
 *   delete   — removes the card and its decoration. No write to the document.
 *   continue — opens an inline composer that posts a follow-up question to the
 *              same Dify workflow. The answer streams back into the card's
 *              thread and the conversation_id is reused for multi-turn.
 */

import { useMemo, useState } from 'react'
import { Archive, Check, MessageSquarePlus, RotateCcw, Trash2, Wand2, AlertTriangle, Loader2, Send } from 'lucide-react'
import { useAnnotationStore, type AnnotationItem } from '../../stores/annotationStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import './annotation-panel.css'

interface AnnotationPanelProps {
  documentId: string | null
  activeId?: string | null
  onFocus?: (id: string | null) => void
}

export function AnnotationPanel({ documentId, activeId, onFocus }: AnnotationPanelProps) {
  const itemsById = useAnnotationStore((s) => s.items)
  const [showArchived, setShowArchived] = useState(false)
  const [compareCluster, setCompareCluster] = useState<AnnotationItem[] | null>(null)

  const items = useMemo(() => {
    if (!documentId) return [] as AnnotationItem[]
    return Object.values(itemsById)
      .filter((it) => it.documentId === documentId && it.status !== 'deleted' && it.status !== 'archived' && it.status !== 'superseded')
      .sort((a, b) => a.range.from - b.range.from)
  }, [itemsById, documentId])

  // Group by exact range match
  const clusters = useMemo(() => {
    const groups = new Map<string, AnnotationItem[]>()
    for (const item of items) {
      const key = `${item.range.from}:${item.range.to}`
      const existing = groups.get(key) ?? []
      existing.push(item)
      groups.set(key, existing)
    }
    return Array.from(groups.values())
  }, [items])

  const archivedItems = useMemo(() => {
    if (!documentId) return [] as AnnotationItem[]
    return Object.values(itemsById)
      .filter((it) => it.documentId === documentId && it.status === 'archived')
      .sort((a, b) => a.range.from - b.range.from)
  }, [itemsById, documentId])

  if (!documentId) {
    return <div className="ann-empty">未打开文档</div>
  }

  return (
    <div className="ann-panel-root">
      {archivedItems.length > 0 && (
        <button
          className={`ann-archive-toggle ${showArchived ? 'active' : ''}`}
          onClick={() => setShowArchived((v) => !v)}
        >
          <Archive size={13} />
          已归档 ({archivedItems.length})
        </button>
      )}

      {showArchived ? (
        <div className="ann-list archived-list">
          <div className="ann-archive-header">
            <span>已归档批注</span>
            <button className="ghost-mini" onClick={() => setShowArchived(false)}>返回</button>
          </div>
          {archivedItems.map((item) => (
            <ArchivedCard key={item.id} item={item} />
          ))}
        </div>
      ) : (
        <div className="ann-list">
          {items.length === 0 && (
            <div className="ann-empty">
              还没有批注。在编辑器中选中文字后，到右侧"工作流"Tab 选一个 workflow 点"运行"。
            </div>
          )}
          {items.map((item) => (
            <AnnotationCard
              key={item.id}
              item={item}
              isActive={item.id === activeId}
              onFocus={() => onFocus?.(item.id === activeId ? null : item.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function AnnotationCard({
  item,
  isActive,
  onFocus,
}: {
  item: AnnotationItem
  isActive: boolean
  onFocus: () => void
}) {
  const accept = useAnnotationStore((s) => s.accept)
  const remove = useAnnotationStore((s) => s.remove)
  const appendThread = useAnnotationStore((s) => s.appendThread)
  const runWorkflow = useWorkflowStore((s) => s.run)
  const isRunning = useWorkflowStore((s) => s.running[item.workflowId])

  const [composerOpen, setComposerOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const handleAccept = () => accept(item.id)
  const handleDelete = () => {
    if (confirm('永久删除此批注？此操作不可恢复。')) remove(item.id)
  }

  const handleContinue = async () => {
    const question = draft.trim()
    if (!question) return
    appendThread(item.id, { role: 'user', content: question })
    setDraft('')
    setComposerOpen(false)
    await runWorkflow(
      item.workflowId,
      {
        document_id: item.documentId,
        range_start: item.range.from,
        range_end: item.range.to,
        inputs: {
          target_text: item.targetText,
          previous_answer: item.thread.findLast?.((m) => m.role === 'agent')?.content ?? '',
        },
        query: question,
        conversation_id: item.conversationId,
      },
      { threadCardId: item.id },
    )
  }

  const isResolved = item.status === 'archived'

  return (
    <div
      className={`ann-card ann-${item.kind} sev-${item.severity} ${isActive ? 'active' : ''} ${isResolved ? 'resolved' : ''}`}
      onClick={onFocus}
    >
      <div className="ann-head">
        <span className="ann-icon">{iconFor(item)}</span>
        <span className="ann-agent">{item.agentName}</span>
        <span className="ann-kind-chip">{labelFor(item.kind)}</span>
        {isResolved && <span className="ann-resolved-chip">已处理</span>}
      </div>

      {item.targetText && <blockquote className="ann-quote">{ellipsis(item.targetText, 120)}</blockquote>}

      {item.content && <p className="ann-body">{item.content}</p>}

      {item.kind === 'suggestion' && item.proposed && (
        <div className="ann-diff">
          <div className="ann-diff-row remove">- {item.original}</div>
          <div className="ann-diff-row add">+ {item.proposed}</div>
          {item.reason && <div className="ann-diff-reason">{item.reason}</div>}
        </div>
      )}

      <Thread messages={item.thread} />

      {composerOpen && (
        <div className="ann-composer" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="向 Agent 追问，比如：再举一个例子 / 这里语气可以更弱吗？"
            rows={2}
            autoFocus
          />
          <div className="ann-composer-actions">
            <button className="ghost-mini" onClick={() => setComposerOpen(false)} disabled={isRunning}>
              取消
            </button>
            <button className="primary-mini" onClick={handleContinue} disabled={isRunning || !draft.trim()}>
              {isRunning ? <Loader2 size={12} className="spin" /> : <Send size={12} />}
              发送
            </button>
          </div>
        </div>
      )}

      <div className="ann-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="ann-btn accept"
          onClick={handleAccept}
          disabled={isResolved}
          title="标记已处理并归档（不会自动修改文档，请在编辑器里手动改）"
        >
          <Check size={12} />
          已处理
        </button>
        <button className="ann-btn delete" onClick={handleDelete} disabled={isResolved} title="永久删除">
          <Trash2 size={12} />
          删除
        </button>
        <button
          className="ann-btn continue"
          onClick={() => setComposerOpen((v) => !v)}
          disabled={isRunning}
          title="向 Agent 追问"
        >
          <MessageSquarePlus size={12} />
          追问
        </button>
      </div>
    </div>
  )
}

function Thread({ messages }: { messages: AnnotationItem['thread'] }) {
  if (messages.length <= 1) return null
  return (
    <ul className="ann-thread">
      {messages.slice(1).map((m) => (
        <li key={m.id} className={`ann-thread-msg ${m.role}`}>
          <span className="ann-thread-role">{m.role === 'user' ? '我' : 'Agent'}</span>
          <span className="ann-thread-content">{m.content}</span>
        </li>
      ))}
    </ul>
  )
}

function iconFor(item: AnnotationItem) {
  if (item.kind === 'suggestion') return <Wand2 size={14} />
  if (item.kind === 'risk') return <AlertTriangle size={14} />
  return <MessageSquarePlus size={14} />
}

function ArchivedCard({ item }: { item: AnnotationItem }) {
  const restore = useAnnotationStore((s) => s.restore)
  const remove = useAnnotationStore((s) => s.remove)
  return (
    <div className="ann-card ann-archived">
      <div className="ann-head">
        <span className="ann-icon">{iconFor(item)}</span>
        <span className="ann-agent">{item.agentName}</span>
        <span className="ann-kind-chip">{labelFor(item.kind)}</span>
      </div>
      <p className="ann-body archived-body">{ellipsis(item.content, 100)}</p>
      <div className="ann-actions" onClick={(e) => e.stopPropagation()}>
        <button className="ann-btn accept" onClick={() => restore(item.id)} title="重新打开">
          <RotateCcw size={12} /> 重开
        </button>
        <button className="ann-btn delete" onClick={() => remove(item.id)} title="永久删除">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

function labelFor(kind: AnnotationItem['kind']) {
  if (kind === 'suggestion') return '建议'
  if (kind === 'risk') return '风险'
  return '批注'
}

function ellipsis(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * AnnotationPanel — right-column list of cards, one per Annotation /
 * Suggestion / Risk / user comment. Each card supports three actions:
 *
 *   accept   — applies the suggestion (or marks the card resolved) and writes
 *              back to documentStore.content.
 *   delete   — removes the card and its decoration. No write to the document.
 *   continue — opens an inline composer that posts a follow-up question to the
 *              same Dify workflow. The answer streams back into the card's
 *              thread and the conversation_id is reused for multi-turn.
 *
 * User-authored comments are a special kind ('user-comment') and behave
 * slightly differently: no initial agent reply, and follow-ups are only
 * enabled once an agent is @-mentioned.
 */

import { useMemo, useState } from 'react'
import { Archive, Check, Columns3, MessageSquarePlus, RotateCcw, Trash2, Wand2, AlertTriangle, Loader2, Send, X, MessageCircle } from 'lucide-react'
import { useAnnotationStore, type AnnotationItem } from '../../stores/annotationStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import type { CachedWorkflow } from '../../services/backendApi'
import { CommentComposer } from './CommentComposer'
import { parseMentions, segmentText, buildAgentPrompt } from '../../services/mentions'
import './annotation-panel.css'

interface AnnotationPanelProps {
  documentId: string | null
  activeId?: string | null
  onFocus?: (id: string | null) => void
  // The selection the user clicked "add comment" on, if any. When non-null,
  // a composer is rendered at the top of the panel.
  pendingComment?: {
    range: { from: number; to: number }
    targetText: string
  } | null
  onDismissPendingComment?: () => void
  agents?: CachedWorkflow[]
}

export function AnnotationPanel({
  documentId,
  activeId,
  onFocus,
  pendingComment,
  onDismissPendingComment,
  agents = [],
}: AnnotationPanelProps) {
  const itemsById = useAnnotationStore((s) => s.items)
  const createUserComment = useAnnotationStore((s) => s.createUserComment)
  const runWorkflow = useWorkflowStore((s) => s.run)
  const [showArchived, setShowArchived] = useState(false)
  const [compareCluster, setCompareCluster] = useState<AnnotationItem[] | null>(null)

  const items = useMemo(() => {
    if (!documentId) return [] as AnnotationItem[]
    return Object.values(itemsById)
      .filter((it) => it.documentId === documentId && it.status !== 'deleted' && it.status !== 'archived' && it.status !== 'superseded')
      .sort((a, b) => a.range.from - b.range.from)
  }, [itemsById, documentId])

  const rangeGroups = useMemo(() => {
    const groups = new Map<string, AnnotationItem[]>()
    for (const item of items) {
      const key = `${item.range.from}:${item.range.to}`
      const existing = groups.get(key) ?? []
      existing.push(item)
      groups.set(key, existing)
    }
    return groups
  }, [items])

  const archivedItems = useMemo(() => {
    if (!documentId) return [] as AnnotationItem[]
    return Object.values(itemsById)
      .filter((it) => it.documentId === documentId && it.status === 'archived')
      .sort((a, b) => a.range.from - b.range.from)
  }, [itemsById, documentId])

  const handleSubmitComment = async ({
    content,
    mentionedAgents,
  }: {
    content: string
    mentionedAgents: { id: string; name: string }[]
  }) => {
    if (!documentId || !pendingComment) return
    const { range, targetText } = pendingComment

    if (mentionedAgents.length === 0) {
      // Plain user comment, no agent trigger.
      createUserComment({
        documentId,
        range,
        targetText,
        content,
      })
      onDismissPendingComment?.()
      return
    }

    // For each mentioned agent, create a separate card so replies stay isolated.
    for (const agent of mentionedAgents) {
      const cardId = createUserComment({
        documentId,
        range,
        targetText,
        content,
        mentionedAgentId: agent.id,
        mentionedAgentName: agent.name,
      })
      // Build the agent prompt including the selected text + user comment.
      const prompt = buildAgentPrompt({
        targetText,
        userMessage: content,
        threadHistory: [],
      })
      // Fire the workflow; the run store will append to this card's thread.
      void runWorkflow(
        agent.id,
        {
          document_id: documentId,
          range_start: range.from,
          range_end: range.to,
          inputs: {
            target_text: targetText,
            user_message: content,
          },
          query: prompt,
        },
        { threadCardId: cardId },
      )
    }
    onDismissPendingComment?.()
  }

  if (!documentId) {
    return <div className="ann-empty">未打开文档</div>
  }

  return (
    <div className="ann-panel-root">
      {pendingComment && (
        <CommentComposer
          selectedText={pendingComment.targetText}
          agents={agents}
          onSubmit={handleSubmitComment}
          onCancel={() => onDismissPendingComment?.()}
        />
      )}

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
          {items.length === 0 && !pendingComment && (
            <div className="ann-empty">
              还没有批注。在编辑器中选中文字后，使用浮动工具栏新建批注，或到右侧"工作流"Tab 选一个 workflow 运行。
            </div>
          )}
          {items.map((item) => {
            const siblings = rangeGroups.get(`${item.range.from}:${item.range.to}`) ?? [item]
            return (
              <AnnotationCard
                key={item.id}
                item={item}
                siblings={siblings}
                isActive={item.id === activeId}
                agents={agents}
                onFocus={() => onFocus?.(item.id === activeId ? null : item.id)}
                onCompare={() => setCompareCluster(siblings)}
              />
            )
          })}
        </div>
      )}
      {compareCluster && (
        <ComparisonModal
          items={compareCluster}
          onClose={() => setCompareCluster(null)}
        />
      )}
    </div>
  )
}

function AnnotationCard({
  item,
  siblings,
  isActive,
  agents,
  onFocus,
  onCompare,
}: {
  item: AnnotationItem
  siblings: AnnotationItem[]
  isActive: boolean
  agents: CachedWorkflow[]
  onFocus: () => void
  onCompare: () => void
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

    // Build prompt with full thread history so the agent has context.
    const prompt = buildAgentPrompt({
      targetText: item.targetText,
      userMessage: question,
      threadHistory: item.thread.map((m) => ({
        role: m.role,
        content: m.content,
        agentName: m.agentName ?? item.agentName,
      })),
    })

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
        query: prompt,
        conversation_id: item.conversationId,
      },
      { threadCardId: item.id },
    )
  }

  const isResolved = item.status === 'archived'
  const isUserComment = item.kind === 'user-comment'
  const canFollowUp = !!item.workflowId // Plain user comments have no agent

  return (
    <div
      className={`ann-card ann-${item.kind} sev-${item.severity} ${isActive ? 'active' : ''} ${isResolved ? 'resolved' : ''}`}
      onClick={onFocus}
    >
      <div className="ann-head">
        <span className="ann-icon">{iconFor(item)}</span>
        <span className="ann-agent">
          {isUserComment
            ? item.agentName
              ? `@${item.agentName}`
              : '我的批注'
            : item.agentName}
        </span>
        <span className="ann-kind-chip">{labelFor(item.kind)}</span>
        {isResolved && <span className="ann-resolved-chip">已处理</span>}
      </div>

      {item.targetText && <blockquote className="ann-quote">{ellipsis(item.targetText, 120)}</blockquote>}

      {item.content && (
        <p className="ann-body">
          {isUserComment ? renderWithMentions(item.content, agents) : item.content}
        </p>
      )}

      {item.kind === 'suggestion' && item.proposed && (
        <div className="ann-diff">
          <div className="ann-diff-row remove">- {item.original}</div>
          <div className="ann-diff-row add">+ {item.proposed}</div>
          {item.reason && <div className="ann-diff-reason">{item.reason}</div>}
        </div>
      )}

      <Thread messages={item.thread} isUserCommentCard={isUserComment} agents={agents} />

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
        {canFollowUp && (
          <button
            className="ann-btn continue"
            onClick={() => setComposerOpen((v) => !v)}
            disabled={isRunning}
            title="向 Agent 追问"
          >
            <MessageSquarePlus size={12} />
            追问
          </button>
        )}
        {siblings.length > 1 && (
          <button
            className="ann-btn compare"
            onClick={onCompare}
            title={`${siblings.length - 1} 个其他 Agent 也针对这段文字给出了建议，并排对比`}
          >
            <Columns3 size={12} />
            对比 {siblings.length}
          </button>
        )}
      </div>
    </div>
  )
}

function Thread({
  messages,
  isUserCommentCard,
  agents,
}: {
  messages: AnnotationItem['thread']
  isUserCommentCard: boolean
  agents: CachedWorkflow[]
}) {
  // User-comment cards: thread starts with the user message, so show all.
  // Agent cards: thread[0] is the agent's initial output already rendered in
  // the card body, so skip it.
  const visible = isUserCommentCard ? messages : messages.slice(1)
  if (visible.length === 0) return null
  return (
    <ul className="ann-thread">
      {visible.map((m) => (
        <li key={m.id} className={`ann-thread-msg ${m.role}`}>
          <span className="ann-thread-role">
            {m.role === 'user' ? '我' : m.agentName ?? 'Agent'}
          </span>
          <span className="ann-thread-content">
            {m.role === 'user' ? renderWithMentions(m.content, agents) : m.content}
          </span>
        </li>
      ))}
    </ul>
  )
}

function renderWithMentions(text: string, agents: CachedWorkflow[]): React.ReactNode[] {
  const candidates = agents.map((a) => ({ id: a.id, name: a.name }))
  const mentions = parseMentions(text, candidates)
  const segments = segmentText(text, mentions)
  return segments.map((seg, i) => {
    if (seg.type === 'mention') {
      return (
        <span key={i} className="mention-tag" title={`@${seg.agent.name}`}>
          {seg.raw}
        </span>
      )
    }
    return <span key={i}>{seg.content}</span>
  })
}

function iconFor(item: AnnotationItem) {
  if (item.kind === 'suggestion') return <Wand2 size={14} />
  if (item.kind === 'risk') return <AlertTriangle size={14} />
  if (item.kind === 'user-comment') return <MessageCircle size={14} />
  return <MessageSquarePlus size={14} />
}

function ArchivedCard({ item }: { item: AnnotationItem }) {
  const restore = useAnnotationStore((s) => s.restore)
  const remove = useAnnotationStore((s) => s.remove)
  return (
    <div className="ann-card ann-archived">
      <div className="ann-head">
        <span className="ann-icon">{iconFor(item)}</span>
        <span className="ann-agent">{item.agentName || '我的批注'}</span>
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
  if (kind === 'user-comment') return '评论'
  return '批注'
}

function ellipsis(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function ComparisonModal({
  items,
  onClose,
}: {
  items: AnnotationItem[]
  onClose: () => void
}) {
  return (
    <div className="comparison-modal-overlay" onClick={onClose}>
      <div className="comparison-modal" onClick={(e) => e.stopPropagation()}>
        <div className="comparison-modal-header">
          <div>
            <strong>多 Agent 对比</strong>
            <span className="comparison-subtitle"> · {items.length} 条建议针对同一段文字</span>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
        <blockquote className="comparison-target">
          {ellipsis(items[0].targetText || '', 240)}
        </blockquote>
        <div className="comparison-grid">
          {items.map((it) => (
            <div key={it.id} className={`comparison-col ann-${it.kind}`}>
              <div className="ann-head">
                <span className="ann-icon">{iconFor(it)}</span>
                <span className="ann-agent">{it.agentName}</span>
                <span className="ann-kind-chip">{labelFor(it.kind)}</span>
              </div>
              <div className="comparison-body">{it.content}</div>
              {it.kind === 'suggestion' && it.proposed && (
                <div className="ann-diff">
                  <div className="ann-diff-row remove">- {it.original}</div>
                  <div className="ann-diff-row add">+ {it.proposed}</div>
                  {it.reason && <div className="ann-diff-reason">{it.reason}</div>}
                </div>
              )}
              {it.thread.length > 1 && (
                <ul className="ann-thread">
                  {it.thread.slice(1).map((m) => (
                    <li key={m.id} className={`ann-thread-msg ${m.role}`}>
                      <span className="ann-thread-role">{m.role === 'user' ? '我' : m.agentName ?? 'Agent'}</span>
                      <span className="ann-thread-content">{m.content}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        <div className="comparison-footer">
          只读对比。关闭后在编辑器中手动修改文档。
        </div>
      </div>
    </div>
  )
}

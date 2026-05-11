/**
 * annotationStore — Layer 6 state for annotations / suggestions / risks
 * surfaced in the workspace.
 *
 * Each card is a single AnnotationItem regardless of its semantic type.
 * Cards carry the data needed to draw a CodeMirror decoration AND to render
 * a panel card with three actions: accept, delete, continue.
 *
 * - accept:   for suggestions, applies `proposed` to the document; for
 *             annotations/risks it is a no-op resolution and just marks the
 *             card resolved.
 * - delete:   removes the card and its decoration; nothing is written back to
 *             the document.
 * - continue: opens a follow-up query against the same Dify workflow, carried
 *             in a thread of messages anchored to this card.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Annotation, Risk, Suggestion } from '../types/agent'
import type { ParsedAgentOutput } from '../services/outputParser'
import { mapRangeThrough, type DocChange } from '../services/rangeTracker'
import type { AttachedFile } from '../services/mentions'
import { operationApi } from '../services/operationApi'
import { uuid } from '../lib/uuid'

export type CardKind = 'annotation' | 'suggestion' | 'risk' | 'user-comment'
export type CardStatus = 'pending' | 'accepted' | 'archived' | 'deleted' | 'superseded'

// V3 Phase 4 — user's review of the annotation itself (orthogonal to
// CardStatus). Tracks whether the user has acted on this annotation, not
// whether they liked the Agent output.
export type ReviewStatus = 'open' | 'considered' | 'addressed' | 'dismissed'

export type EvaluationVerdict = 'positive' | 'negative'

export type EvaluationAdoption =
  | 'unknown'
  | 'used'
  | 'partially_used'
  | 'not_used'
  | 'later'

export type EvaluationTargetType =
  | 'agent_output'
  | 'workflow_run'
  | 'annotation'
  | 'suggestion'

export interface AgentEvaluation {
  id: string
  annotationId: string
  targetType: EvaluationTargetType
  targetId: string
  verdict: EvaluationVerdict
  reason: string
  tags: string[]
  adoption: EvaluationAdoption
  trainingCandidate: boolean
  context: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ThreadMessage {
  id: string
  role: 'agent' | 'user'
  content: string
  createdAt: Date
  // For agent messages: which agent produced this reply (used when a single
  // comment has @-mentioned multiple agents so we can label each turn).
  agentId?: string
  agentName?: string
}

export interface AnnotationItem {
  id: string
  documentId: string
  workflowId: string
  agentName: string
  kind: CardKind
  status: CardStatus
  range: { from: number; to: number }
  targetText: string
  // The headline content shown on the card.
  content: string
  severity: 'low' | 'medium' | 'high'
  // Suggestion-specific
  original?: string
  proposed?: string
  reason?: string
  // Risk-specific
  riskType?: Risk['riskType']
  mitigation?: string
  // Conversation context for follow-up queries.
  conversationId?: string
  thread: ThreadMessage[]
  /** Files the user attached via @-mention when creating / continuing this card.
   *  Kept so the UI can render `📎 name` chips without hitting the filesystem. */
  attachedFiles?: AttachedFile[]
  createdAt: Date
}

interface AnnotationState {
  items: Record<string, AnnotationItem>
  // Track which workflow run produced which cards (used to clear/replace on re-run).
  byRun: Record<string, string[]>
  // V3 Phase 4 — user-driven review state, kept separate from CardStatus so an
  // archived card can still be marked `dismissed`, etc.
  reviewStatusByAnnotation: Record<string, ReviewStatus>
  evaluationsByAnnotation: Record<string, AgentEvaluation[]>

  ingestRun: (params: {
    runId: string
    workflowId: string
    documentId: string
    agentName: string
    conversationId?: string
    parsed: ParsedAgentOutput
  }) => void

  // Create a user-authored comment card (optionally mentioning agents).
  createUserComment: (params: {
    documentId: string
    range: { from: number; to: number }
    targetText: string
    content: string
    mentionedAgentId?: string
    mentionedAgentName?: string
    attachedFiles?: AttachedFile[]
  }) => string

  accept: (id: string) => void
  remove: (id: string) => void
  archive: (id: string) => void
  restore: (id: string) => void
  applyDocumentChange: (documentId: string, changes: DocChange[]) => void
  appendThread: (id: string, message: Omit<ThreadMessage, 'id' | 'createdAt'>) => void
  setConversationId: (id: string, conversationId: string) => void

  // V3 Phase 4 actions
  setReviewStatus: (annotationId: string, status: ReviewStatus) => void
  addEvaluation: (
    annotationId: string,
    draft: Omit<AgentEvaluation, 'id' | 'annotationId' | 'createdAt' | 'updatedAt'>,
  ) => string
  updateEvaluation: (
    annotationId: string,
    evaluationId: string,
    patch: Partial<Omit<AgentEvaluation, 'id' | 'annotationId' | 'createdAt'>>,
  ) => void
  deleteEvaluation: (annotationId: string, evaluationId: string) => void
  /** Returns historical tags across all evaluations sorted by frequency desc.
   *  Used by EvaluationPanel for autocomplete suggestions. */
  allEvaluationTags: () => string[]

  visibleForDocument: (documentId: string) => AnnotationItem[]
  archivedForDocument: (documentId: string) => AnnotationItem[]
}

export const useAnnotationStore = create<AnnotationState>()(
  persist(
    (set, get) => ({
      items: {},
      byRun: {},
      reviewStatusByAnnotation: {},
      evaluationsByAnnotation: {},

      ingestRun: ({ runId, workflowId, documentId, agentName, conversationId, parsed }) => {
    const newItems: AnnotationItem[] = []
    const baseAgent = agentName || workflowId

    for (const a of parsed.annotations) {
      newItems.push(makeFromAnnotation(a, workflowId, documentId, baseAgent, conversationId))
    }
    for (const s of parsed.suggestions) {
      newItems.push(makeFromSuggestion(s, workflowId, documentId, baseAgent, conversationId))
    }
    for (const r of parsed.risks) {
      newItems.push(makeFromRisk(r, workflowId, documentId, baseAgent, conversationId))
    }

    set((state) => {
      const items = { ...state.items }
      for (const it of newItems) items[it.id] = it
      return {
        items,
        byRun: { ...state.byRun, [runId]: newItems.map((it) => it.id) },
      }
    })
  },

  createUserComment: ({ documentId, range, targetText, content, mentionedAgentId, mentionedAgentName, attachedFiles }) => {
    const id = uuid()
    const item: AnnotationItem = {
      id,
      documentId,
      workflowId: mentionedAgentId ?? '',
      agentName: mentionedAgentName ?? '',
      kind: 'user-comment',
      status: 'pending',
      range,
      targetText,
      content,
      severity: 'medium',
      thread: [
        { id: uuid(), role: 'user', content, createdAt: new Date() },
      ],
      attachedFiles: attachedFiles && attachedFiles.length > 0 ? attachedFiles : undefined,
      createdAt: new Date(),
    }
    set((state) => ({ items: { ...state.items, [id]: item } }))
    return id
  },

  accept: (id) => {
    const item = get().items[id]
    if (!item || item.status !== 'pending') return
    // "采纳 / 已处理" = 归档。不自动写回文档；用户手动去编辑器改（git-style）。
    set((state) => ({
      items: {
        ...state.items,
        [id]: { ...item, status: 'archived' },
      },
    }))
    // Best-effort audit log; ignore network failures so the UI action stays
    // snappy and offline-friendly.
    void operationApi
      .record(item.documentId, {
        type: 'accept_suggestion',
        payload: {
          annotation_id: item.id,
          kind: item.kind,
          workflow_id: item.workflowId,
          agent_name: item.agentName,
          range_start: item.range.from,
          range_end: item.range.to,
          target_text_excerpt: (item.targetText ?? '').slice(0, 200),
        },
      })
      .catch(() => {})
  },

  remove: (id) => {
    const item = get().items[id]
    set((state) => {
      if (!state.items[id]) return state
      return {
        items: { ...state.items, [id]: { ...state.items[id], status: 'deleted' } },
      }
    })
    if (item && (item.kind === 'suggestion' || item.kind === 'annotation' || item.kind === 'risk')) {
      void operationApi
        .record(item.documentId, {
          type: 'reject_suggestion',
          payload: {
            annotation_id: item.id,
            kind: item.kind,
            workflow_id: item.workflowId,
            agent_name: item.agentName,
            range_start: item.range.from,
            range_end: item.range.to,
            target_text_excerpt: (item.targetText ?? '').slice(0, 200),
          },
        })
        .catch(() => {})
    }
  },

  archive: (id) => {
    set((state) => {
      const item = state.items[id]
      if (!item || item.status === 'deleted' || item.status === 'archived') return state
      return {
        items: { ...state.items, [id]: { ...item, status: 'archived' } },
      }
    })
  },

  restore: (id) => {
    set((state) => {
      const item = state.items[id]
      if (!item || item.status !== 'archived') return state
      return {
        items: { ...state.items, [id]: { ...item, status: 'pending' } },
      }
    })
  },

  applyDocumentChange: (documentId, changes) => {
    if (changes.length === 0) return
    set((state) => {
      const items = { ...state.items }
      let changed = false
      for (const [id, item] of Object.entries(items)) {
        if (item.documentId !== documentId) continue
        if (item.status === 'deleted' || item.status === 'superseded') continue
        const newRange = mapRangeThrough(item.range, changes)
        if (newRange === null) {
          items[id] = { ...item, status: 'superseded' }
          changed = true
        } else if (newRange.from !== item.range.from || newRange.to !== item.range.to) {
          items[id] = { ...item, range: newRange }
          changed = true
        }
      }
      return changed ? { items } : state
    })
  },

  appendThread: (id, message) => {
    set((state) => {
      const item = state.items[id]
      if (!item) return state
      return {
        items: {
          ...state.items,
          [id]: {
            ...item,
            thread: [
              ...item.thread,
              { id: uuid(), createdAt: new Date(), ...message },
            ],
          },
        },
      }
    })
  },

  setConversationId: (id, conversationId) => {
    set((state) => {
      const item = state.items[id]
      if (!item || item.conversationId === conversationId) return state
      return {
        items: { ...state.items, [id]: { ...item, conversationId } },
      }
    })
  },

  setReviewStatus: (annotationId, status) => {
    set((state) => {
      if (state.reviewStatusByAnnotation[annotationId] === status) return state
      return {
        reviewStatusByAnnotation: {
          ...state.reviewStatusByAnnotation,
          [annotationId]: status,
        },
      }
    })
  },

  addEvaluation: (annotationId, draft) => {
    const id = uuid()
    const now = new Date().toISOString()
    const evaluation: AgentEvaluation = {
      ...draft,
      tags: normalizeTagList(draft.tags),
      id,
      annotationId,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      evaluationsByAnnotation: {
        ...state.evaluationsByAnnotation,
        [annotationId]: [...(state.evaluationsByAnnotation[annotationId] ?? []), evaluation],
      },
    }))
    return id
  },

  updateEvaluation: (annotationId, evaluationId, patch) => {
    set((state) => {
      const list = state.evaluationsByAnnotation[annotationId]
      if (!list) return state
      let changed = false
      const next = list.map((e) => {
        if (e.id !== evaluationId) return e
        changed = true
        const patched: AgentEvaluation = {
          ...e,
          ...patch,
          tags: patch.tags ? normalizeTagList(patch.tags) : e.tags,
          updatedAt: new Date().toISOString(),
        }
        return patched
      })
      if (!changed) return state
      return {
        evaluationsByAnnotation: {
          ...state.evaluationsByAnnotation,
          [annotationId]: next,
        },
      }
    })
  },

  deleteEvaluation: (annotationId, evaluationId) => {
    set((state) => {
      const list = state.evaluationsByAnnotation[annotationId]
      if (!list) return state
      const next = list.filter((e) => e.id !== evaluationId)
      if (next.length === list.length) return state
      const nextMap = { ...state.evaluationsByAnnotation }
      if (next.length === 0) {
        delete nextMap[annotationId]
      } else {
        nextMap[annotationId] = next
      }
      return { evaluationsByAnnotation: nextMap }
    })
  },

  allEvaluationTags: () => {
    const counts = new Map<string, number>()
    for (const list of Object.values(get().evaluationsByAnnotation)) {
      for (const ev of list) {
        for (const tag of ev.tags) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1)
        }
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t)
  },

  visibleForDocument: (documentId) =>
    Object.values(get().items)
      .filter((it) => it.documentId === documentId && it.status !== 'deleted' && it.status !== 'archived' && it.status !== 'superseded')
      .sort((a, b) => a.range.from - b.range.from),

  archivedForDocument: (documentId) =>
    Object.values(get().items)
      .filter((it) => it.documentId === documentId && it.status === 'archived')
      .sort((a, b) => a.range.from - b.range.from),
    }),
    {
      name: 'yuwan-annotations-v1',
      // Date fields need custom serialization for localStorage
      version: 2,
      partialize: (state) => ({
        items: state.items,
        byRun: state.byRun,
        reviewStatusByAnnotation: state.reviewStatusByAnnotation,
        evaluationsByAnnotation: state.evaluationsByAnnotation,
      }),
      // V3 Phase 4 added two new persisted maps. Old payloads (version < 2)
      // don't carry them, so rehydrated state would have undefined entries
      // and any selector reading `state.reviewStatusByAnnotation[id]` would
      // crash. Backfill empty objects so the new selectors stay safe.
      merge: (persisted, current) => {
        const p = (persisted as Partial<AnnotationState>) ?? {}
        return {
          ...current,
          items: p.items ?? {},
          byRun: p.byRun ?? {},
          reviewStatusByAnnotation: p.reviewStatusByAnnotation ?? {},
          evaluationsByAnnotation: p.evaluationsByAnnotation ?? {},
        }
      },
    },
  ),
)

// --- factories -------------------------------------------------------------

function makeFromAnnotation(
  a: Omit<Annotation, 'agentId'>,
  workflowId: string,
  documentId: string,
  agentName: string,
  conversationId?: string,
): AnnotationItem {
  return {
    id: a.id,
    documentId,
    workflowId,
    agentName,
    kind: 'annotation',
    status: 'pending',
    range: a.targetRange,
    targetText: a.targetText,
    content: a.content,
    severity: (a.severity as AnnotationItem['severity']) ?? 'medium',
    conversationId,
    thread: [{ id: uuid(), role: 'agent', content: a.content, createdAt: new Date() }],
    createdAt: a.createdAt,
  }
}

function makeFromSuggestion(
  s: Omit<Suggestion, 'agentId'>,
  workflowId: string,
  documentId: string,
  agentName: string,
  conversationId?: string,
): AnnotationItem {
  const headline = s.reason ? `${s.reason}` : `建议：${truncate(s.proposed, 60)}`
  return {
    id: s.id,
    documentId,
    workflowId,
    agentName,
    kind: 'suggestion',
    status: 'pending',
    range: s.targetRange,
    targetText: s.original,
    content: headline,
    severity: 'medium',
    original: s.original,
    proposed: s.proposed,
    reason: s.reason,
    conversationId,
    thread: [{ id: uuid(), role: 'agent', content: headline, createdAt: new Date() }],
    createdAt: s.createdAt,
  }
}

function makeFromRisk(
  r: Omit<Risk, 'agentId'>,
  workflowId: string,
  documentId: string,
  agentName: string,
  conversationId?: string,
): AnnotationItem {
  return {
    id: r.id,
    documentId,
    workflowId,
    agentName,
    kind: 'risk',
    status: 'pending',
    range: r.targetRange,
    targetText: '',
    content: r.description,
    severity: r.severity === 'critical' ? 'high' : (r.severity as AnnotationItem['severity']),
    riskType: r.riskType,
    mitigation: r.mitigation,
    conversationId,
    thread: [{ id: uuid(), role: 'agent', content: r.description, createdAt: new Date() }],
    createdAt: r.createdAt,
  }
}

function truncate(s: string | undefined, n: number) {
  if (!s) return ''
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

/**
 * Normalize raw tag input from the user:
 *   - strip a single leading '#'
 *   - trim surrounding whitespace
 *   - drop empties
 *   - deduplicate case-insensitively, keeping the first-seen casing
 *
 * `#高价值` and `高价值` collapse to `高价值`; `#HighValue` and `highvalue`
 * collapse to whichever was added first.
 */
export function normalizeTagList(tags: readonly string[]): string[] {
  const seen = new Map<string, string>()
  for (const raw of tags) {
    const cleaned = raw.replace(/^#+/, '').trim()
    if (!cleaned) continue
    const key = cleaned.toLowerCase()
    if (!seen.has(key)) seen.set(key, cleaned)
  }
  return Array.from(seen.values())
}

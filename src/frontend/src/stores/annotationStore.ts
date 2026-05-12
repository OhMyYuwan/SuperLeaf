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
import {
  annotationEvaluationApi,
  type AnnotationDto,
  type AnnotationCreateIn,
  type AnnotationPatchIn,
  type AnnotationThreadMessageDto,
  type EvaluationOut,
  type ReviewStateOut,
} from '../services/annotationEvaluationApi'
import { uuid } from '../lib/uuid'
import { createUserScopedStorage } from './_userScopedStorage'
import { showToast } from '../features/shared/toast'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function threadToDto(thread: ThreadMessage[]): AnnotationThreadMessageDto[] {
  return thread.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    created_at: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
    agent_id: m.agentId ?? null,
    agent_name: m.agentName ?? null,
  }))
}

function threadFromDto(thread: AnnotationThreadMessageDto[]): ThreadMessage[] {
  return (thread ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: new Date(m.created_at),
    agentId: m.agent_id ?? undefined,
    agentName: m.agent_name ?? undefined,
  }))
}

function itemFromDto(d: AnnotationDto): AnnotationItem {
  return {
    id: d.id,
    documentId: d.doc_id,
    workflowId: d.workflow_id,
    agentName: d.agent_name,
    kind: d.kind,
    status: d.status as CardStatus,
    range: { from: d.range_from, to: d.range_to },
    targetText: d.target_text,
    content: d.content,
    severity: d.severity,
    original: d.original || undefined,
    proposed: d.proposed || undefined,
    reason: d.reason || undefined,
    riskType: (d.risk_type || undefined) as AnnotationItem['riskType'],
    mitigation: d.mitigation || undefined,
    conversationId: d.conversation_id || undefined,
    thread: threadFromDto(d.thread),
    attachedFiles: d.attached_files && d.attached_files.length > 0
      ? (d.attached_files as unknown as AttachedFile[])
      : undefined,
    createdAt: new Date(d.created_at),
  }
}

function itemToCreateBody(item: AnnotationItem): AnnotationCreateIn {
  return {
    id: item.id,
    doc_id: item.documentId,
    kind: item.kind,
    status: item.status,
    range_from: item.range.from,
    range_to: item.range.to,
    target_text: item.targetText ?? '',
    content: item.content ?? '',
    severity: item.severity,
    workflow_id: item.workflowId ?? '',
    agent_name: item.agentName ?? '',
    conversation_id: item.conversationId ?? '',
    original: item.original ?? '',
    proposed: item.proposed ?? '',
    reason: item.reason ?? '',
    risk_type: item.riskType ?? '',
    mitigation: item.mitigation ?? '',
    thread: threadToDto(item.thread),
    // Round-trip the attached files object as-is — the backend stores it
    // as opaque JSON (see schemas.AnnotationIn).
    attached_files: (item.attachedFiles ?? []) as unknown as Record<string, unknown>[],
    created_at: item.createdAt instanceof Date
      ? item.createdAt.toISOString()
      : String(item.createdAt),
  }
}

function patchAnnotationRemote(annotationId: string, patch: AnnotationPatchIn, action: string): void {
  void annotationEvaluationApi.patchAnnotation(annotationId, patch).catch((err) => {
    showToast(`未能${action}：${errMsg(err)}`, { level: 'error' })
    console.error('[annotationStore] patch failed', annotationId, action, err)
  })
}

function createAnnotationRemote(item: AnnotationItem, onFail: () => void): void {
  void annotationEvaluationApi
    .createAnnotation(itemToCreateBody(item))
    .catch((err) => {
      onFail()
      showToast(`未能保存批注：${errMsg(err)}`, { level: 'error' })
      console.error('[annotationStore] create annotation failed', item.id, err)
    })
}

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

  // V3 Phase 4 actions. Mutations are still synchronous so the UI stays
  // snappy and offline-friendly; each one fires a fire-and-forget POST to
  // the backend (REQ-0034). `hydrateForDoc` does the reverse: pull the
  // canonical state from the backend and overwrite the local maps for
  // this doc.
  setReviewStatus: (annotationId: string, status: ReviewStatus, docId: string) => void
  addEvaluation: (
    annotationId: string,
    draft: Omit<AgentEvaluation, 'id' | 'annotationId' | 'createdAt' | 'updatedAt'>,
    docId: string,
  ) => string
  updateEvaluation: (
    annotationId: string,
    evaluationId: string,
    patch: Partial<Omit<AgentEvaluation, 'id' | 'annotationId' | 'createdAt'>>,
  ) => void
  deleteEvaluation: (annotationId: string, evaluationId: string) => void

  // Apply-only local writes for SSE events from other clients. These do NOT
  // send anything to the backend; they just merge the server-confirmed
  // state into local maps. Called by the ProjectEventBridge.
  applyRemoteReviewStatus: (annotationId: string, status: ReviewStatus) => void
  applyRemoteEvaluationUpsert: (annotationId: string, evaluation: AgentEvaluation) => void
  applyRemoteEvaluationDelete: (annotationId: string, evaluationId: string) => void
  applyRemoteAnnotationUpsert: (item: AnnotationItem) => void
  applyRemoteAnnotationDelete: (annotationId: string) => void

  hydrateForDoc: (docId: string) => Promise<void>
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
    // Persist each card so cross-device clients see them.
    for (const it of newItems) {
      const id = it.id
      createAnnotationRemote(it, () => {
        set((state) => {
          if (!state.items[id]) return state
          const items = { ...state.items }
          delete items[id]
          return { items }
        })
      })
    }
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
    createAnnotationRemote(item, () => {
      set((state) => {
        if (!state.items[id]) return state
        const items = { ...state.items }
        delete items[id]
        return { items }
      })
    })
    return id
  },

  accept: (id) => {
    const item = get().items[id]
    if (!item || item.status !== 'pending') return
    // "采纳 / 已处理" = 归档。不自动写回文档；用户手动去编辑器改（git-style）。
    const prevStatus = item.status
    set((state) => ({
      items: {
        ...state.items,
        [id]: { ...item, status: 'archived' },
      },
    }))
    void annotationEvaluationApi
      .patchAnnotation(id, { status: 'archived' })
      .catch((err) => {
        set((state) => {
          const cur = state.items[id]
          if (!cur) return state
          return { items: { ...state.items, [id]: { ...cur, status: prevStatus } } }
        })
        showToast(`未能采纳批注：${errMsg(err)}`, { level: 'error' })
      })
    // Audit-log (separate concern; can fail silently).
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
    if (!item) return
    // Optimistic delete: drop from local map; if backend rejects, restore.
    set((state) => {
      if (!state.items[id]) return state
      const items = { ...state.items }
      delete items[id]
      return { items }
    })
    void annotationEvaluationApi.removeAnnotation(id).catch((err) => {
      set((state) => ({ items: { ...state.items, [id]: item } }))
      showToast(`未能删除批注：${errMsg(err)}`, { level: 'error' })
    })
    if (item.kind === 'suggestion' || item.kind === 'annotation' || item.kind === 'risk') {
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
    const prev = get().items[id]
    if (!prev || prev.status === 'deleted' || prev.status === 'archived') return
    set((state) => ({
      items: { ...state.items, [id]: { ...prev, status: 'archived' } },
    }))
    void annotationEvaluationApi.patchAnnotation(id, { status: 'archived' }).catch((err) => {
      set((state) => {
        const cur = state.items[id]
        if (!cur) return state
        return { items: { ...state.items, [id]: { ...cur, status: prev.status } } }
      })
      showToast(`未能归档批注：${errMsg(err)}`, { level: 'error' })
    })
  },

  restore: (id) => {
    const prev = get().items[id]
    if (!prev || prev.status !== 'archived') return
    set((state) => ({
      items: { ...state.items, [id]: { ...prev, status: 'pending' } },
    }))
    void annotationEvaluationApi.patchAnnotation(id, { status: 'pending' }).catch((err) => {
      set((state) => {
        const cur = state.items[id]
        if (!cur) return state
        return { items: { ...state.items, [id]: { ...cur, status: prev.status } } }
      })
      showToast(`未能恢复批注：${errMsg(err)}`, { level: 'error' })
    })
  },

  applyDocumentChange: (documentId, changes) => {
    if (changes.length === 0) return
    const supersededIds: string[] = []
    set((state) => {
      const items = { ...state.items }
      let changed = false
      for (const [id, item] of Object.entries(items)) {
        if (item.documentId !== documentId) continue
        if (item.status === 'deleted' || item.status === 'superseded') continue
        const newRange = mapRangeThrough(item.range, changes)
        if (newRange === null) {
          items[id] = { ...item, status: 'superseded' }
          supersededIds.push(id)
          changed = true
        } else if (newRange.from !== item.range.from || newRange.to !== item.range.to) {
          items[id] = { ...item, range: newRange }
          changed = true
        }
      }
      return changed ? { items } : state
    })
    // Range offsets are computed on-the-fly by other clients via
    // mapRangeThrough as they receive doc.updated events; we don't push
    // each typing-induced offset to the server. But once a card is
    // superseded (its target text was deleted), that's a permanent state
    // change every device must see — sync it.
    for (const id of supersededIds) {
      patchAnnotationRemote(id, { status: 'superseded' }, '同步批注状态')
    }
  },

  appendThread: (id, message) => {
    const prev = get().items[id]
    if (!prev) return
    const newMsg: ThreadMessage = { id: uuid(), createdAt: new Date(), ...message }
    const nextThread = [...prev.thread, newMsg]
    set((state) => {
      const item = state.items[id]
      if (!item) return state
      return {
        items: { ...state.items, [id]: { ...item, thread: nextThread } },
      }
    })
    void annotationEvaluationApi
      .patchAnnotation(id, { thread: threadToDto(nextThread) })
      .catch((err) => {
        // Roll back the appended message.
        set((state) => {
          const cur = state.items[id]
          if (!cur) return state
          return {
            items: {
              ...state.items,
              [id]: { ...cur, thread: cur.thread.filter((m) => m.id !== newMsg.id) },
            },
          }
        })
        showToast(`未能保存讨论消息：${errMsg(err)}`, { level: 'error' })
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

  setReviewStatus: (annotationId, status, docId) => {
    const prev = get().reviewStatusByAnnotation[annotationId]
    if (prev === status) return
    // Optimistic: update local first, roll back on failure.
    set((state) => ({
      reviewStatusByAnnotation: {
        ...state.reviewStatusByAnnotation,
        [annotationId]: status,
      },
    }))
    void annotationEvaluationApi
      .setReviewStatus(annotationId, docId, status)
      .catch((err) => {
        set((state) => {
          const map = { ...state.reviewStatusByAnnotation }
          if (prev === undefined) delete map[annotationId]
          else map[annotationId] = prev
          return { reviewStatusByAnnotation: map }
        })
        showToast(`未能保存批注状态：${errMsg(err)}`, { level: 'error' })
      })
  },

  addEvaluation: (annotationId, draft, docId) => {
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
    void annotationEvaluationApi
      .create(annotationId, {
        id,
        doc_id: docId,
        target_type: draft.targetType,
        target_id: draft.targetId,
        verdict: draft.verdict,
        reason: draft.reason,
        tags: evaluation.tags,
        adoption: draft.adoption,
        training_candidate: draft.trainingCandidate,
        context: draft.context ?? {},
      })
      .catch((err) => {
        // Roll back the optimistic local insert.
        set((state) => {
          const list = state.evaluationsByAnnotation[annotationId]
          if (!list) return state
          const next = list.filter((e) => e.id !== id)
          const map = { ...state.evaluationsByAnnotation }
          if (next.length === 0) delete map[annotationId]
          else map[annotationId] = next
          return { evaluationsByAnnotation: map }
        })
        showToast(`未能保存评价：${errMsg(err)}`, { level: 'error' })
      })
    return id
  },

  updateEvaluation: (annotationId, evaluationId, patch) => {
    const prevList = get().evaluationsByAnnotation[annotationId]
    const prevEntry = prevList?.find((e) => e.id === evaluationId)
    if (!prevEntry) return
    set((state) => {
      const list = state.evaluationsByAnnotation[annotationId]
      if (!list) return state
      const next = list.map((e) =>
        e.id !== evaluationId
          ? e
          : {
              ...e,
              ...patch,
              tags: patch.tags ? normalizeTagList(patch.tags) : e.tags,
              updatedAt: new Date().toISOString(),
            },
      )
      return {
        evaluationsByAnnotation: {
          ...state.evaluationsByAnnotation,
          [annotationId]: next,
        },
      }
    })
    void annotationEvaluationApi
      .update(annotationId, evaluationId, {
        verdict: patch.verdict,
        reason: patch.reason,
        tags: patch.tags,
        adoption: patch.adoption,
        training_candidate: patch.trainingCandidate,
        context: patch.context as Record<string, unknown> | undefined,
      })
      .catch((err) => {
        // Roll back to prev entry.
        set((state) => {
          const list = state.evaluationsByAnnotation[annotationId]
          if (!list) return state
          const restored = list.map((e) => (e.id === evaluationId ? prevEntry : e))
          return {
            evaluationsByAnnotation: {
              ...state.evaluationsByAnnotation,
              [annotationId]: restored,
            },
          }
        })
        showToast(`未能更新评价：${errMsg(err)}`, { level: 'error' })
      })
  },

  deleteEvaluation: (annotationId, evaluationId) => {
    const prevList = get().evaluationsByAnnotation[annotationId]
    const removed = prevList?.find((e) => e.id === evaluationId)
    if (!removed) return
    set((state) => {
      const list = state.evaluationsByAnnotation[annotationId]
      if (!list) return state
      const next = list.filter((e) => e.id !== evaluationId)
      const nextMap = { ...state.evaluationsByAnnotation }
      if (next.length === 0) delete nextMap[annotationId]
      else nextMap[annotationId] = next
      return { evaluationsByAnnotation: nextMap }
    })
    void annotationEvaluationApi.remove(annotationId, evaluationId).catch((err) => {
      // Restore the removed entry at its original position.
      set((state) => {
        const list = state.evaluationsByAnnotation[annotationId] ?? []
        const restoredOrder = (prevList ?? []).map((e) =>
          e.id === evaluationId ? removed : (list.find((x) => x.id === e.id) ?? e),
        )
        return {
          evaluationsByAnnotation: {
            ...state.evaluationsByAnnotation,
            [annotationId]: restoredOrder,
          },
        }
      })
      showToast(`未能删除评价：${errMsg(err)}`, { level: 'error' })
    })
  },

  applyRemoteReviewStatus: (annotationId, status) => {
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

  applyRemoteEvaluationUpsert: (annotationId, evaluation) => {
    set((state) => {
      const list = state.evaluationsByAnnotation[annotationId] ?? []
      const idx = list.findIndex((e) => e.id === evaluation.id)
      const next = idx >= 0
        ? list.map((e) => (e.id === evaluation.id ? evaluation : e))
        : [...list, evaluation]
      return {
        evaluationsByAnnotation: {
          ...state.evaluationsByAnnotation,
          [annotationId]: next,
        },
      }
    })
  },

  applyRemoteAnnotationUpsert: (item) => {
    set((state) => ({ items: { ...state.items, [item.id]: item } }))
  },

  applyRemoteAnnotationDelete: (annotationId) => {
    set((state) => {
      if (!state.items[annotationId]) return state
      const items = { ...state.items }
      delete items[annotationId]
      return { items }
    })
  },

  applyRemoteEvaluationDelete: (annotationId, evaluationId) => {
    set((state) => {
      const list = state.evaluationsByAnnotation[annotationId]
      if (!list) return state
      const next = list.filter((e) => e.id !== evaluationId)
      const map = { ...state.evaluationsByAnnotation }
      if (next.length === 0) delete map[annotationId]
      else map[annotationId] = next
      return { evaluationsByAnnotation: map }
    })
  },

  hydrateForDoc: async (docId) => {
    // Pull canonical state from the backend. Server wins for everything
    // tied to this doc; only evaluations/review_states for OTHER docs are
    // preserved (since this API call is doc-scoped).
    let evaluations: EvaluationOut[]
    let reviewStates: ReviewStateOut[]
    let annotations: AnnotationDto[]
    try {
      ;[evaluations, reviewStates, annotations] = await Promise.all([
        annotationEvaluationApi.listByDoc(docId),
        annotationEvaluationApi.listReviewStatesByDoc(docId),
        annotationEvaluationApi.listAnnotationsByDoc(docId),
      ])
    } catch (err) {
      console.warn('[annotationStore] hydrateForDoc failed', err)
      showToast('未能加载最新批注（离线或会话失效）', { level: 'warning' })
      return
    }
    // Replace this doc's annotations completely. Items belonging to other
    // docs (e.g. when the user has multiple docs open) are preserved.
    set((state) => {
      const nextItems: Record<string, AnnotationItem> = {}
      for (const [id, it] of Object.entries(state.items)) {
        if (it.documentId !== docId) nextItems[id] = it
      }
      for (const dto of annotations) {
        nextItems[dto.id] = itemFromDto(dto)
      }
      return { items: nextItems }
    })
    set((state) => {
      const evalMap = { ...state.evaluationsByAnnotation }
      // Replace this doc's slice with the server response while keeping
      // entries belonging to other docs intact (annotation_id is unique
      // across docs in practice — annotations are uuids — but the cleanest
      // model is per-doc swap).
      for (const [aid, list] of Object.entries(evalMap)) {
        if (list.length > 0 && list[0].annotationId === aid) {
          // can't easily tell doc affinity from local cache; keep as-is
          // unless the server returned this annotation_id below
        }
      }
      const grouped: Record<string, AgentEvaluation[]> = {}
      for (const e of evaluations) {
        const local: AgentEvaluation = {
          id: e.id,
          annotationId: e.annotation_id,
          targetType: e.target_type,
          targetId: e.target_id,
          verdict: e.verdict,
          reason: e.reason,
          tags: e.tags,
          adoption: e.adoption,
          trainingCandidate: e.training_candidate,
          context: e.context,
          createdAt: e.created_at,
          updatedAt: e.updated_at,
        }
        ;(grouped[e.annotation_id] ??= []).push(local)
      }
      // Replace any annotation_id that the server has data for; preserve
      // others (offline edits not yet visible to the server).
      for (const aid of Object.keys(grouped)) {
        evalMap[aid] = grouped[aid]
      }

      const statusMap = { ...state.reviewStatusByAnnotation }
      for (const r of reviewStates) {
        statusMap[r.annotation_id] = r.status
      }
      return {
        evaluationsByAnnotation: evalMap,
        reviewStatusByAnnotation: statusMap,
      }
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
      storage: createUserScopedStorage(),
      // V3 phase 2.5: `items` and `byRun` are no longer persisted — the
      // backend is the source of truth (loaded via hydrateForDoc on doc
      // open, kept in sync via SSE). Persisting them caused stale cards to
      // hydrate on a new device or for a different account, and could not
      // capture cross-device edits.
      version: 3,
      partialize: (state) => ({
        reviewStatusByAnnotation: state.reviewStatusByAnnotation,
        evaluationsByAnnotation: state.evaluationsByAnnotation,
      }),
      merge: (persisted, current) => {
        const p = (persisted as Partial<AnnotationState>) ?? {}
        return {
          ...current,
          // Always start clean — annotations come from the backend.
          items: {},
          byRun: {},
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

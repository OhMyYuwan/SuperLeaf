/**
 * conversationStore — chat-style discussions per (document, agent).
 *
 * Each conversation is scoped to one document + one agent (workflow). The store
 * tracks active conversations, messages, and streaming state. SSE streaming is
 * handled here so the UI can just render the state.
 */

import { create } from 'zustand'
import {
  conversationApi,
  buildHeaders,
  type Conversation,
  type ConversationCreate,
  type ConversationUpdate,
  type EditProposal,
  type Message,
  type MessageInject,
  type MessageSend,
} from '../services/backendApi'
import { operationApi } from '../services/operationApi'
import { applyWriteOutput, readCurrentText } from './writingStore'
import { useCollaborationStore } from './collaborationStore'
import * as Y from 'yjs'

export interface ProposalEntry extends EditProposal {
  conversation_id: string
  status: 'pending' | 'accepted' | 'rejected' | 'stale'
  received_at: string
  /**
   * Yjs RelativePositions captured the moment the proposal arrived in the
   * client. They follow the underlying characters as concurrent peers insert
   * or delete around them, so accepting later still hits the right spot.
   * Only set when the doc is in collab mode at proposal-receipt time.
   */
  rel_pos_start?: Y.RelativePosition
  rel_pos_end?: Y.RelativePosition
}

interface ConversationState {
  conversations: Record<string, Conversation>
  messages: Record<string, Message[]>
  loading: boolean
  error: string | null

  // Streaming state: which conversation is currently receiving a message.
  streaming: Record<string, boolean>
  streamingDelta: Record<string, string>

  // Edit proposals from native Agents, keyed by conversation_id. Lives in
  // memory only — refreshing the page drops them. Persisting them would
  // require a new table since they sit between SSE events and user action.
  proposals: Record<string, ProposalEntry[]>

  loadConversations: (filter?: { documentId?: string; workflowId?: string }) => Promise<void>
  createConversation: (body: ConversationCreate) => Promise<Conversation | null>
  renameConversation: (id: string, title: string) => Promise<Conversation | null>
  togglePinConversation: (id: string, pinned: boolean) => Promise<Conversation | null>
  pinAtCurrentPosition: (id: string, sortIndex: number) => Promise<Conversation | null>
  releaseFixedPosition: (id: string) => Promise<Conversation | null>
  reorderConversation: (id: string, sortIndex: number, isPinned: boolean) => Promise<Conversation | null>
  deleteConversation: (id: string) => Promise<void>
  loadMessages: (conversationId: string) => Promise<void>
  sendMessage: (conversationId: string, body: MessageSend) => Promise<void>
  injectMessage: (conversationId: string, body: MessageInject) => Promise<Message | null>
  clearStreamingDelta: (conversationId: string) => void
  acceptProposal: (conversationId: string, proposalId: string) => Promise<{ ok: boolean; stale?: boolean }>
  rejectProposal: (conversationId: string, proposalId: string) => void
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: {},
  messages: {},
  loading: false,
  error: null,
  streaming: {},
  streamingDelta: {},
  proposals: {},

  loadConversations: async (filter) => {
    set({ loading: true, error: null })
    try {
      const list = await conversationApi.list(
        filter
          ? {
              document_id: filter.documentId,
              workflow_id: filter.workflowId,
            }
          : undefined,
      )
      const conversations = Object.fromEntries(list.map((c) => [c.id, c]))
      set({ conversations, loading: false })
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  createConversation: async (body) => {
    try {
      const created = await conversationApi.create(body)
      set((s) => ({
        conversations: { ...s.conversations, [created.id]: created },
        messages: { ...s.messages, [created.id]: [] },
      }))
      return created
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  renameConversation: async (id, title) => {
    try {
      const updated = await conversationApi.update(id, { title })
      set((s) => ({
        conversations: { ...s.conversations, [id]: updated },
      }))
      return updated
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  togglePinConversation: async (id, pinned) => {
    try {
      const updated = await conversationApi.update(id, { is_pinned: pinned })
      set((s) => ({ conversations: { ...s.conversations, [id]: updated } }))
      return updated
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  pinAtCurrentPosition: async (id, sortIndex) => {
    try {
      const updated = await conversationApi.update(id, { sort_index: sortIndex })
      set((s) => ({ conversations: { ...s.conversations, [id]: updated } }))
      return updated
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  releaseFixedPosition: async (id) => {
    try {
      const updated = await conversationApi.update(id, { clear_sort_index: true })
      set((s) => ({ conversations: { ...s.conversations, [id]: updated } }))
      return updated
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  reorderConversation: async (id, sortIndex, isPinned) => {
    try {
      const updated = await conversationApi.update(id, {
        sort_index: sortIndex,
        is_pinned: isPinned,
      })
      set((s) => ({ conversations: { ...s.conversations, [id]: updated } }))
      return updated
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  deleteConversation: async (id) => {
    try {
      await conversationApi.delete(id)
      set((s) => {
        const { [id]: _, ...rest } = s.conversations
        const { [id]: __, ...restMsgs } = s.messages
        return { conversations: rest, messages: restMsgs }
      })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  loadMessages: async (conversationId) => {
    try {
      const msgs = await conversationApi.listMessages(conversationId)
      set((s) => ({ messages: { ...s.messages, [conversationId]: msgs } }))
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }
  },

  sendMessage: async (conversationId, body) => {
    // Optimistic update: show user message immediately before backend confirms.
    const optimisticMsg: Message = {
      id: `optimistic-${Date.now()}`,
      conversation_id: conversationId,
      role: 'user',
      content: body.content,
      range_start: body.range_start ?? null,
      range_end: body.range_end ?? null,
      inputs: body.inputs ?? null,
      created_at: new Date().toISOString(),
    }
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), optimisticMsg],
      },
      streaming: { ...s.streaming, [conversationId]: true },
      streamingDelta: { ...s.streamingDelta, [conversationId]: '' },
      error: null,
    }))

    // Abort the request if the server hasn't produced any bytes within
    // FIRST_BYTE_TIMEOUT_MS. Clears on first chunk so a long-running
    // agent reply isn't cut off. User-configurable via env.
    const timeoutMs = Number(import.meta.env?.VITE_REQUEST_TIMEOUT_MS ?? 30000)
    const abortCtl = new AbortController()
    const firstByteTimer = setTimeout(() => abortCtl.abort('timeout'), timeoutMs)

    try {
      const headers = buildHeaders({ Accept: 'text/event-stream' })
      const resp = await fetch(conversationApi.sendMessageUrl(conversationId), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortCtl.signal,
        credentials: 'include',
      })
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => resp.statusText)
        throw new Error(`Backend ${resp.status}: ${text?.slice(0, 300) || resp.statusText}`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      let gotFirstChunk = false

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!gotFirstChunk) {
          clearTimeout(firstByteTimer)
          gotFirstChunk = true
        }
        buf += decoder.decode(value, { stream: true })

        let boundary = findEventBoundary(buf)
        while (boundary !== null) {
          const chunk = buf.slice(0, boundary.start)
          buf = buf.slice(boundary.end)
          const parsed = parseSseMessage(chunk)
          if (parsed) {
            handleMessageEvent(set, conversationId, parsed)
          }
          boundary = findEventBoundary(buf)
        }
      }
    } catch (e) {
      const aborted =
        e instanceof DOMException && e.name === 'AbortError'
      set((s) => ({
        streaming: { ...s.streaming, [conversationId]: false },
        error: aborted
          ? `Agent 响应超时（${timeoutMs / 1000}s 内无数据），请重试或检查 Provider`
          : e instanceof Error ? e.message : String(e),
      }))
    } finally {
      clearTimeout(firstByteTimer)
      set((s) => ({
        streaming: { ...s.streaming, [conversationId]: false },
      }))
    }
  },

  clearStreamingDelta: (conversationId) => {
    set((s) => ({ streamingDelta: { ...s.streamingDelta, [conversationId]: '' } }))
  },

  acceptProposal: async (conversationId, proposalId) => {
    const list = get().proposals[conversationId] ?? []
    const proposal = list.find((p) => p.proposal_id === proposalId)
    if (!proposal || proposal.status !== 'pending') {
      return { ok: false }
    }
    // Resolve anchors first: if the doc is in collab mode and we captured
    // RelativePositions on receipt, they tell us where those characters live
    // *now*, after any concurrent inserts/deletes. Falls back to the original
    // offsets when no anchor exists (non-collab mode at receipt time).
    let from = proposal.range_start
    let to = proposal.range_end
    const collab = useCollaborationStore.getState()
    const inCollab =
      !!collab.provider && collab.currentDocId === proposal.document_id
    if (inCollab && proposal.rel_pos_start && proposal.rel_pos_end) {
      const ydoc = collab.provider!.doc
      const absStart = Y.createAbsolutePositionFromRelativePosition(
        proposal.rel_pos_start,
        ydoc,
      )
      const absEnd = Y.createAbsolutePositionFromRelativePosition(
        proposal.rel_pos_end,
        ydoc,
      )
      // Anchors can return null if the underlying type was deleted entirely;
      // in that case we fall back to the literal offsets, which will then
      // fail the content check below and surface as stale.
      if (absStart && absEnd) {
        from = absStart.index
        to = absEnd.index
      }
    }
    // Content check: even with anchors, the *interior* of the range may have
    // been edited. Compare the current slice to the original_text snapshot.
    const live = readCurrentText(proposal.document_id, { from, to })
    if (live !== proposal.original_text) {
      set((s) => ({
        proposals: {
          ...s.proposals,
          [conversationId]: (s.proposals[conversationId] ?? []).map((p) =>
            p.proposal_id === proposalId ? { ...p, status: 'stale' } : p,
          ),
        },
      }))
      return { ok: false, stale: true }
    }
    applyWriteOutput({
      docId: proposal.document_id,
      mode: 'replace-range',
      range: { from, to },
      text: proposal.new_text,
    })
    set((s) => ({
      proposals: {
        ...s.proposals,
        [conversationId]: (s.proposals[conversationId] ?? []).map((p) =>
          p.proposal_id === proposalId ? { ...p, status: 'accepted' } : p,
        ),
      },
    }))
    // Audit-log the acceptance via the existing operations endpoint. Failures
    // are non-fatal — the edit has already landed in the editor.
    void operationApi
      .record(proposal.document_id, {
        type: 'accept_suggestion',
        payload: {
          source: 'agent_propose_doc_edit',
          proposal_id: proposal.proposal_id,
          conversation_id: conversationId,
          range_start: from,
          range_end: to,
          original_range_start: proposal.range_start,
          original_range_end: proposal.range_end,
          reason: proposal.reason,
        },
      })
      .catch(() => undefined)
    return { ok: true }
  },

  rejectProposal: (conversationId, proposalId) => {
    const list = get().proposals[conversationId] ?? []
    const proposal = list.find((p) => p.proposal_id === proposalId)
    if (!proposal) return
    set((s) => ({
      proposals: {
        ...s.proposals,
        [conversationId]: (s.proposals[conversationId] ?? []).map((p) =>
          p.proposal_id === proposalId ? { ...p, status: 'rejected' } : p,
        ),
      },
    }))
    void operationApi
      .record(proposal.document_id, {
        type: 'reject_suggestion',
        payload: {
          source: 'agent_propose_doc_edit',
          proposal_id: proposal.proposal_id,
          conversation_id: conversationId,
        },
      })
      .catch(() => undefined)
  },

  injectMessage: async (conversationId, body) => {
    try {
      const msg = await conversationApi.injectMessage(conversationId, body)
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: [...(s.messages[conversationId] ?? []), msg],
        },
      }))
      return msg
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },
}))

function findEventBoundary(buf: string): { start: number; end: number } | null {
  const crlf = buf.indexOf('\r\n\r\n')
  const lf = buf.indexOf('\n\n')
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { start: crlf, end: crlf + 4 }
  }
  if (lf !== -1) {
    return { start: lf, end: lf + 2 }
  }
  return null
}

function parseSseMessage(chunk: string): { event: string; data: unknown } | null {
  let eventName = 'message'
  const dataLines: string[] = []
  const normalized = chunk.replace(/\r\n/g, '\n')
  for (const line of normalized.split('\n')) {
    if (!line) continue
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    data = raw
  }
  return { event: eventName, data }
}

function handleMessageEvent(
  set: (fn: (s: ConversationState) => Partial<ConversationState>) => void,
  conversationId: string,
  evt: { event: string; data: unknown },
) {
  if (evt.event === 'ylw.msg.user') {
    const msg = evt.data as Message
    set((s) => {
      const existing = s.messages[conversationId] ?? []
      const optimisticIdx = existing.findIndex((m) => m.id.startsWith('optimistic-'))
      if (optimisticIdx !== -1) {
        const updated = [...existing]
        updated[optimisticIdx] = msg
        return { messages: { ...s.messages, [conversationId]: updated } }
      }
      return {
        messages: { ...s.messages, [conversationId]: [...existing, msg] },
      }
    })
  } else if (evt.event === 'ylw.msg.delta') {
    const { delta } = evt.data as { delta: string }
    set((s) => ({
      streamingDelta: {
        ...s.streamingDelta,
        [conversationId]: (s.streamingDelta[conversationId] ?? '') + delta,
      },
    }))
  } else if (evt.event === 'ylw.msg.finished') {
    const msg = evt.data as Message
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), msg],
      },
      streamingDelta: { ...s.streamingDelta, [conversationId]: '' },
    }))
    // Reload conversation to get updated title (auto-generated from first message).
    conversationApi.get(conversationId).then((conv) => {
      set((s) => ({
        conversations: { ...s.conversations, [conversationId]: conv },
      }))
    }).catch(() => {
      // Ignore errors, title update is not critical.
    })
  } else if (evt.event === 'ylw.msg.failed') {
    const { error } = evt.data as { error: string }
    set((s) => ({
      error,
      streamingDelta: { ...s.streamingDelta, [conversationId]: '' },
    }))
  } else if (evt.event === 'ylw.msg.edit_proposal') {
    const data = evt.data as Partial<EditProposal> | null
    if (!data || !data.proposal_id || !data.document_id) return
    const documentId = String(data.document_id)
    const rangeStart = Number(data.range_start ?? 0)
    const rangeEnd = Number(data.range_end ?? 0)
    let originalText = String(data.original_text ?? '')
    let relPosStart: Y.RelativePosition | undefined
    let relPosEnd: Y.RelativePosition | undefined

    // If the doc is in collab mode right now, replace the backend snapshot
    // with the live yText slice (it can be ahead of the DB by hundreds of ms)
    // and pin two RelativePositions so the offsets follow concurrent edits.
    const collab = useCollaborationStore.getState()
    if (collab.provider && collab.currentDocId === documentId) {
      const yText = collab.provider.yText
      const liveLen = yText.length
      const safeStart = Math.max(0, Math.min(rangeStart, liveLen))
      const safeEnd = Math.max(safeStart, Math.min(rangeEnd, liveLen))
      originalText = yText.toString().slice(safeStart, safeEnd)
      // assoc -1 / +1: start sticks to the char to its right, end to the char
      // to its left, so insertions at the boundaries don't widen the range.
      relPosStart = Y.createRelativePositionFromTypeIndex(yText, safeStart, -1)
      relPosEnd = Y.createRelativePositionFromTypeIndex(yText, safeEnd, 1)
    }

    const entry: ProposalEntry = {
      proposal_id: String(data.proposal_id),
      document_id: documentId,
      range_start: rangeStart,
      range_end: rangeEnd,
      original_text: originalText,
      new_text: String(data.new_text ?? ''),
      reason: String(data.reason ?? ''),
      conversation_id: conversationId,
      status: 'pending',
      received_at: new Date().toISOString(),
      rel_pos_start: relPosStart,
      rel_pos_end: relPosEnd,
    }
    set((s) => {
      const existing = s.proposals[conversationId] ?? []
      if (existing.some((p) => p.proposal_id === entry.proposal_id)) return s
      return {
        proposals: {
          ...s.proposals,
          [conversationId]: [...existing, entry],
        },
      }
    })
  }
}

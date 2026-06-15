/**
 * conversationStore — chat-style discussions per (document, agent).
 *
 * Each conversation is scoped to one document + one agent (workflow). The store
 * tracks active conversations, messages, and streaming state. SSE streaming is
 * handled here so the UI can just render the state.
 *
 * 历史上整个 store + 所有 helper 都集中在这一个文件。为了可读性按职责拆到了
 * `./conversation/` 目录：纯工具（sse / grep-inference / preflight-inference /
 * browser-providers）、SSE 事件分发（handle-message-event）、三条 send 流水线
 * （send-{nanobot,codex,claude}）、工具桥接（tool-execution）以及类型与公共
 * resolver。这里只保留 zustand `create()` 主体 + 对外公共 API。
 */

import { create } from 'zustand'
import * as Y from 'yjs'
import {
  conversationApi,
  buildHeaders,
  type Message,
} from '../services/backendApi'
import { operationApi } from '../services/operationApi'
import {
  submitBrowserToolBridgeApprovalResult,
} from '../services/browserToolBridge'
import { applyWriteOutput, readCurrentText } from '../services/documentWriter'
import { useCollaborationStore } from './collaborationStore'
import { useDocumentStore } from './documentStore'

import {
  resolveSuggestionAnnotationContextFromConversation,
} from './conversation/annotation-context'
import {
  findBrowserClaudeProvider,
  findBrowserCodexProvider,
  findBrowserNanobotProvider,
} from './conversation/browser-providers'
import { handleMessageEvent } from './conversation/handle-message-event'
import { sendViaBrowserClaude } from './conversation/send-claude'
import { sendViaBrowserCodex } from './conversation/send-codex'
import { sendViaBrowserNanobot } from './conversation/send-nanobot'
import { findEventBoundary, parseSseMessage } from './conversation/sse'
import type {
  AgentRunStats,
  ConversationState,
  LocalAgentApprovalEntry,
  ProposalEntry,
} from './conversation/types'

// Re-export the public types so existing `import type { ... } from '../stores/
// conversationStore'` lines keep resolving without touching call sites.
export type { AgentRunStats, LocalAgentApprovalEntry, ProposalEntry }

const activeMessageControllers = new Map<string, AbortController>()
const stoppedMessageConversations = new Set<string>()

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: {},
  messages: {},
  loading: false,
  error: null,
  streaming: {},
  streamingDelta: {},
  streamingStats: {},
  messageRunStats: {},
  proposals: {},
  localApprovals: {},

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
        const { [id]: ___, ...restApprovals } = s.localApprovals
        return { conversations: rest, messages: restMsgs, localApprovals: restApprovals }
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
      external_message_id: '',
      error: '',
      created_at: new Date().toISOString(),
    }
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), optimisticMsg],
      },
      streaming: { ...s.streaming, [conversationId]: true },
      streamingDelta: { ...s.streamingDelta, [conversationId]: '' },
      streamingStats: {
        ...s.streamingStats,
        [conversationId]: { filesRead: 0, filesWritten: 0 },
      },
      error: null,
    }))

    // Show a waiting reminder if the server has not produced bytes within this
    // window, but keep the request alive. Long-running local agents should be
    // stopped only by the user.
    const timeoutMs = Number(import.meta.env?.VITE_REQUEST_TIMEOUT_MS ?? 30000)
    const abortCtl = new AbortController()
    activeMessageControllers.set(conversationId, abortCtl)
    const firstByteTimer = window.setTimeout(() => {
      set((s) => {
        const current = s.streamingStats[conversationId] ?? { filesRead: 0, filesWritten: 0 }
        return {
          streamingStats: {
            ...s.streamingStats,
            [conversationId]: {
              ...current,
              waitingReminder: `已等待 ${Math.round(timeoutMs / 1000)} 秒，Agent 仍在运行，可手动停止。`,
            },
          },
        }
      })
    }, Math.max(1000, timeoutMs))

    try {
      const browserNanobot = findBrowserNanobotProvider(conversationId, get)
      if (browserNanobot) {
        let gotFirstChunk = false
        const markActivity = () => {
          if (!gotFirstChunk) {
            clearTimeout(firstByteTimer)
            gotFirstChunk = true
          }
        }
        await sendViaBrowserNanobot({
          conversationId,
          body,
          provider: browserNanobot,
          signal: abortCtl.signal,
          markActivity,
          set,
        })
        return
      }
      const browserCodex = findBrowserCodexProvider(conversationId, get)
      if (browserCodex) {
        let gotFirstChunk = false
        const markActivity = () => {
          if (!gotFirstChunk) {
            clearTimeout(firstByteTimer)
            gotFirstChunk = true
          }
        }
        await sendViaBrowserCodex({
          conversationId,
          body,
          provider: browserCodex,
          signal: abortCtl.signal,
          markActivity,
          set,
        })
        return
      }
      const browserClaude = findBrowserClaudeProvider(conversationId, get)
      if (browserClaude) {
        let gotFirstChunk = false
        const markActivity = () => {
          if (!gotFirstChunk) {
            clearTimeout(firstByteTimer)
            gotFirstChunk = true
          }
        }
        await sendViaBrowserClaude({
          conversationId,
          body,
          provider: browserClaude,
          signal: abortCtl.signal,
          markActivity,
          set,
        })
        return
      }

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
      const stoppedByUser = stoppedMessageConversations.has(conversationId)
      set((s) => ({
        streaming: { ...s.streaming, [conversationId]: false },
        error: stoppedByUser
          ? null
          : aborted
          ? 'Agent 请求已中止'
          : e instanceof Error ? e.message : String(e),
      }))
      if (stoppedByUser) {
        set((s) => {
          const currentDelta = s.streamingDelta[conversationId] ?? ''
          const stoppedId = `stopped-${Date.now()}`
          const stats = {
            ...(s.streamingStats[conversationId] ?? { filesRead: 0, filesWritten: 0 }),
            stopped: true,
          }
          const stoppedMsg: Message = {
            id: stoppedId,
            conversation_id: conversationId,
            role: 'agent',
            content: currentDelta.trim()
              ? `${currentDelta.trim()}\n\n已停止。`
              : '已停止。',
            range_start: null,
            range_end: null,
            external_message_id: '',
            error: '',
            created_at: new Date().toISOString(),
          }
          const { [conversationId]: _, ...restStreamingStats } = s.streamingStats
          return {
            messages: {
              ...s.messages,
              [conversationId]: [...(s.messages[conversationId] ?? []), stoppedMsg],
            },
            streamingDelta: { ...s.streamingDelta, [conversationId]: '' },
            streamingStats: restStreamingStats,
            messageRunStats: { ...s.messageRunStats, [stoppedId]: stats },
          }
        })
      }
    } finally {
      clearTimeout(firstByteTimer)
      activeMessageControllers.delete(conversationId)
      stoppedMessageConversations.delete(conversationId)
      set((s) => ({
        streaming: { ...s.streaming, [conversationId]: false },
        streamingStats: Object.fromEntries(
          Object.entries(s.streamingStats).filter(([id]) => id !== conversationId),
        ),
      }))
    }
  },

  stopMessage: (conversationId) => {
    const ctl = activeMessageControllers.get(conversationId)
    if (!ctl) return
    stoppedMessageConversations.add(conversationId)
    ctl.abort('user')
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
    // Text anchor fallback: when Yjs anchors are not available (non-collab
    // mode), use the agent's original_text to re-locate the edit range.
    // This is more reliable than numeric offsets when the document has been
    // edited since the proposal was created.
    if (!inCollab && proposal.anchor_text) {
      const fullContent =
        useDocumentStore.getState().documents[proposal.document_id]?.content ?? ''
      const anchorIdx = fullContent.indexOf(proposal.anchor_text)
      if (anchorIdx !== -1) {
        from = anchorIdx
        to = anchorIdx + proposal.anchor_text.length
      }
      // If not found, fall back to the original numeric offsets (will go
      // through the content check below and likely surface as stale).
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

  submitLocalApproval: async (conversationId, requestId, decision) => {
    const request = (get().localApprovals[conversationId] ?? []).find((item) => item.id === requestId)
    if (!request) return
    set((s) => ({
      localApprovals: {
        ...s.localApprovals,
        [conversationId]: (s.localApprovals[conversationId] ?? []).map((item) =>
          item.id === requestId
            ? { ...item, status: decision === 'accept' ? 'accepted' : 'rejected', error: '' }
            : item,
        ),
      },
    }))
    try {
      await submitBrowserToolBridgeApprovalResult({
        endpoint: request.endpoint,
        requestId,
        contextSecret: request.context_secret,
        approvalSecret: request.approval_secret,
        decision,
      })
      window.setTimeout(() => {
        set((s) => ({
          localApprovals: {
            ...s.localApprovals,
            [conversationId]: (s.localApprovals[conversationId] ?? []).filter((item) => item.id !== requestId),
          },
        }))
      }, 1200)
    } catch (err) {
      set((s) => ({
        localApprovals: {
          ...s.localApprovals,
          [conversationId]: (s.localApprovals[conversationId] ?? []).map((item) =>
            item.id === requestId
              ? { ...item, status: 'error', error: err instanceof Error ? err.message : String(err) }
              : item,
          ),
        },
      }))
    }
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

/**
 * 公共 wrapper：保持 `(conversationId, data)` 旧签名给测试和 UI 复用。把当前对
 * 话从 `useConversationStore` 取出来，再委托给纯函数版本。
 */
export function resolveSuggestionAnnotationContext(
  conversationId: string,
  data: Record<string, unknown> = {},
): { sourceConversationId: string; workflowId: string; agentName: string } {
  const conversation = useConversationStore.getState().conversations[conversationId]
  return resolveSuggestionAnnotationContextFromConversation(conversation, conversationId, data)
}

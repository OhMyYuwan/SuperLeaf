/**
 * 把后端 SSE 事件流（或浏览器侧工具桥事件）应用到 conversation store 的状态上。
 *
 * 处理的事件类型：
 * - ylw.msg.user：替换 optimistic 用户消息或追加新消息
 * - ylw.msg.delta：追加到当前 streamingDelta
 * - native.agent.tool：累计读写文件计数 + bridge 状态 + 本机 / 外部会话 ID
 * - ylw.msg.finished：把 streamingDelta 落库为正式 agent 消息，绑定该流期间收
 *   到的 proposal cards 到这条消息上
 * - ylw.msg.failed：清空流，记录错误
 * - ylw.msg.edit_proposal：构造 ProposalEntry，如果文档处于 collab 模式则用
 *   YText 实时切片覆盖 originalText，并钉两个 RelativePosition 让 offset 跟着
 *   并发编辑漂移
 * - ylw.msg.suggestion_created：把 suggestion 转成 annotation 写到批注 store
 *
 * 通过 `set / getConversation` 依赖注入和 store 解耦，避免和 `conversation
 * Store.ts` 形成模块循环。
 */

import * as Y from 'yjs'
import {
  conversationApi,
  type EditProposal,
  type Message,
} from '../../services/backendApi'
import { useAnnotationStore } from '../annotationStore'
import { useCollaborationStore } from '../collaborationStore'
import { useConversationStore } from '../conversationStore'
import { resolveSuggestionAnnotationContextFromConversation } from './annotation-context'
import { bridgeStatusFromToolEvent } from './sse'
import type { ConversationSet, ConversationState, ProposalEntry } from './types'

export function handleMessageEvent(
  set: ConversationSet,
  conversationId: string,
  evt: { event: string; data: unknown },
) {
  if (evt.event === 'ylw.msg.user') {
    const msg = evt.data as Message
    set((s: ConversationState) => {
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
    set((s: ConversationState) => ({
      streamingDelta: {
        ...s.streamingDelta,
        [conversationId]: (s.streamingDelta[conversationId] ?? '') + delta,
      },
    }))
  } else if (evt.event === 'native.agent.tool') {
    const data = evt.data as {
      name?: string
      failed?: boolean
      tool_kind?: string
      error?: unknown
      local_session_id?: unknown
      external_session_id?: unknown
      workspace_path?: unknown
    }
    const name = String(data?.name ?? '')
    const failed = Boolean(data?.failed)
    const localSessionId = String(data?.local_session_id ?? '').trim()
    const externalSessionId = String(data?.external_session_id ?? '').trim()
    const workspacePath = String(data?.workspace_path ?? '').trim()
    const sessionRuntime =
      data?.tool_kind === 'claude_local'
        ? 'claude-local'
        : data?.tool_kind === 'codex_local'
          ? 'codex-local'
          : undefined
    const isRead =
      name === 'read_agent_file' ||
      name === 'project_read_doc' ||
      name === 'project_outline' ||
      name === 'project_grep'
    const isWrite =
      !failed &&
      (data?.tool_kind === 'project_write' ||
        name === 'project_write_text_file' ||
        name === 'project_create_text_file')
    const bridgeUpdate = bridgeStatusFromToolEvent(name, failed, data)
    if (isRead || isWrite || bridgeUpdate || localSessionId || externalSessionId || workspacePath) {
      set((s: ConversationState) => {
        const current = s.streamingStats[conversationId] ?? {
          filesRead: 0,
          filesWritten: 0,
        }
        return {
          streamingStats: {
            ...s.streamingStats,
            [conversationId]: {
              filesRead: current.filesRead + (isRead ? 1 : 0),
              filesWritten: current.filesWritten + (isWrite ? 1 : 0),
              stopped: current.stopped,
              waitingReminder: current.waitingReminder,
              bridgeStatus: bridgeUpdate?.status ?? current.bridgeStatus,
              bridgeError: bridgeUpdate
                ? bridgeUpdate.error
                : current.bridgeError,
              localSessionId: localSessionId || current.localSessionId,
              externalSessionId: externalSessionId || current.externalSessionId,
              sessionRuntime: sessionRuntime ?? current.sessionRuntime,
              workspacePath: workspacePath || current.workspacePath,
            },
          },
        }
      })
    }
  } else if (evt.event === 'ylw.msg.finished') {
    const msg = evt.data as Message
    set((s: ConversationState) => {
      // Bind any proposals that arrived during this stream (message_id === '')
      // to the freshly-persisted agent message id, so the cards render under
      // the right reply instead of accumulating at the bottom.
      const existingProposals = s.proposals[conversationId] ?? []
      const boundProposals = existingProposals.some((p) => p.message_id === '')
        ? existingProposals.map((p) =>
            p.message_id === '' ? { ...p, message_id: msg.id } : p,
          )
        : existingProposals
      return {
        messages: {
          ...s.messages,
          [conversationId]: [...(s.messages[conversationId] ?? []), msg],
        },
        proposals:
          boundProposals === existingProposals
            ? s.proposals
            : { ...s.proposals, [conversationId]: boundProposals },
        streamingDelta: { ...s.streamingDelta, [conversationId]: '' },
        streamingStats: Object.fromEntries(
          Object.entries(s.streamingStats).filter(([id]) => id !== conversationId),
        ),
        messageRunStats: {
          ...s.messageRunStats,
          [msg.id]: s.streamingStats[conversationId] ?? { filesRead: 0, filesWritten: 0 },
        },
      }
    })
    // Reload conversation to get updated title (auto-generated from first message).
    conversationApi.get(conversationId).then((conv) => {
      set((s: ConversationState) => ({
        conversations: { ...s.conversations, [conversationId]: conv },
      }))
    }).catch(() => {
      // Ignore errors, title update is not critical.
    })
  } else if (evt.event === 'ylw.msg.failed') {
    const { error } = evt.data as { error: string }
    set((s: ConversationState) => ({
      error,
      streamingDelta: { ...s.streamingDelta, [conversationId]: '' },
      streamingStats: Object.fromEntries(
        Object.entries(s.streamingStats).filter(([id]) => id !== conversationId),
      ),
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
      message_id: '',
      rel_pos_start: relPosStart,
      rel_pos_end: relPosEnd,
    }
    set((s: ConversationState) => {
      const existing = s.proposals[conversationId] ?? []
      if (existing.some((p) => p.proposal_id === entry.proposal_id)) return s
      return {
        proposals: {
          ...s.proposals,
          [conversationId]: [...existing, entry],
        },
      }
    })
  } else if (evt.event === 'ylw.msg.suggestion_created') {
    const data = evt.data as Record<string, unknown> | null
    if (!data?.suggestion_id || !data?.document_id) return

    const documentId = String(data.document_id)
    const rangeStart = Number(data.range_start ?? 0)
    const rangeEnd = Number(data.range_end ?? 0)
    const originalText = String(data.original_text ?? '')
    const proposedText = String(data.proposed_text ?? '')
    const content = String(data.content ?? '')
    const reason = String(data.reason ?? '')

    // Resolve conversation context for the annotation
    const conversation = useConversationStore.getState().conversations[conversationId]
    const {
      sourceConversationId,
      workflowId,
      agentName,
    } = resolveSuggestionAnnotationContextFromConversation(conversation, conversationId, data)

    const annStore = useAnnotationStore.getState()
    const annotationId = annStore.createFromAgent({
      documentId,
      range: { from: rangeStart, to: rangeEnd },
      originalText,
      proposedText: proposedText || undefined,
      content,
      reason: reason || undefined,
      conversationId: sourceConversationId,
      agentName,
      workflowId,
    })

    // Insert a lightweight reference message into the chat stream
    // The actual review happens in the annotation panel
    // eslint-disable-next-line no-console
    console.log('[conversationStore] Created suggestion annotation:', annotationId)
  }
}

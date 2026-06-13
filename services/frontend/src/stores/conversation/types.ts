/**
 * conversationStore 内部和对外暴露的类型定义。
 *
 * `ProposalEntry` / `AgentRunStats` / `LocalAgentApprovalEntry` 也被 UI 层
 * import（DiscussionTab 等），所以从根 `conversationStore.ts` 重新导出，外部
 * 不感知拆分。`ConversationState` 是 store 内部接口，本目录下的 helper 通过它
 * 类型化 `set/get`，不对外。
 */

import type * as Y from 'yjs'
import type {
  Conversation,
  ConversationCreate,
  EditProposal,
  Message,
  MessageInject,
  MessageSend,
} from '../../services/backendApi'
import type { BrowserToolBridgeApprovalRequest } from '../../services/browserToolBridge'

export interface ProposalEntry extends EditProposal {
  conversation_id: string
  status: 'pending' | 'accepted' | 'rejected' | 'stale'
  received_at: string
  /**
   * The agent message this proposal belongs to. Empty string while the
   * reply is still streaming; filled in when ylw.msg.finished arrives so
   * the card renders directly under its source message.
   */
  message_id: string
  /**
   * Yjs RelativePositions captured the moment the proposal arrived in the
   * client. They follow the underlying characters as concurrent peers insert
   * or delete around them, so accepting later still hits the right spot.
   * Only set when the doc is in collab mode at proposal-receipt time.
   */
  rel_pos_start?: Y.RelativePosition
  rel_pos_end?: Y.RelativePosition
}

export interface AgentRunStats {
  filesRead: number
  filesWritten: number
  stopped?: boolean
  waitingReminder?: string
  bridgeStatus?: 'connected' | 'recovering' | 'error'
  bridgeError?: string
  localSessionId?: string
  externalSessionId?: string
  sessionRuntime?: 'codex-local' | 'claude-local'
  workspacePath?: string
}

export interface LocalAgentApprovalEntry extends BrowserToolBridgeApprovalRequest {
  endpoint: string
  status: 'pending' | 'accepted' | 'rejected' | 'error'
  error?: string
}

export interface ConversationState {
  conversations: Record<string, Conversation>
  messages: Record<string, Message[]>
  loading: boolean
  error: string | null

  // Streaming state: which conversation is currently receiving a message.
  streaming: Record<string, boolean>
  streamingDelta: Record<string, string>
  streamingStats: Record<string, AgentRunStats>
  messageRunStats: Record<string, AgentRunStats>

  // Edit proposals from native Agents, keyed by conversation_id. Lives in
  // memory only — refreshing the page drops them. Persisting them would
  // require a new table since they sit between SSE events and user action.
  proposals: Record<string, ProposalEntry[]>
  localApprovals: Record<string, LocalAgentApprovalEntry[]>

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
  stopMessage: (conversationId: string) => void
  injectMessage: (conversationId: string, body: MessageInject) => Promise<Message | null>
  clearStreamingDelta: (conversationId: string) => void
  acceptProposal: (conversationId: string, proposalId: string) => Promise<{ ok: boolean; stale?: boolean }>
  rejectProposal: (conversationId: string, proposalId: string) => void
  submitLocalApproval: (conversationId: string, requestId: string, decision: 'accept' | 'reject') => Promise<void>
}

/**
 * The only Zustand setter shape used by the action helpers. Defined explicitly
 * so helper modules can type-check against it without importing the rest of
 * Zustand's create<T>() machinery.
 */
export type ConversationSet = (fn: (s: ConversationState) => Partial<ConversationState>) => void
export type ConversationGet = () => ConversationState

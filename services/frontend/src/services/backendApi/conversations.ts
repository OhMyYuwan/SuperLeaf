/**
 * 讨论/聊天会话、消息与浏览器工具桥接相关 API。
 */

import { http, BASE } from './client'
import type { HttpInit } from './client'
import type { ProviderDraft } from './providers'

export interface Conversation {
  id: string
  document_id: string
  workflow_id: string
  title: string
  user_renamed: boolean
  is_pinned: boolean
  sort_index: number | null
  external_conversation_id: string
  created_at: string
  updated_at: string
  message_count: number
  last_message_preview: string
}

export interface ConversationCreate {
  document_id: string
  workflow_id: string
  title?: string
}

export interface ConversationUpdate {
  title?: string
  is_pinned?: boolean
  sort_index?: number
  clear_sort_index?: boolean
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'agent' | 'system'
  content: string
  range_start: number | null
  range_end: number | null
  external_message_id: string
  error: string
  created_at: string
}

export interface MessageSend {
  content: string
  range_start?: number
  range_end?: number
  inputs?: Record<string, unknown>
}

export interface BrowserNanobotPrepare {
  run_id: string
  provider_id: string
  endpoint: string
  bridge_endpoint?: string
  model: string
  messages: NanobotChatMessage[]
  tools: NanobotToolDefinition[]
  user_message: Message
  document_id: string
  range_start: number
  range_end: number
  inputs: Record<string, unknown>
}

export interface BrowserCodexPrepare {
  run_id: string
  provider_id: string
  endpoint: string
  model: string
  system_prompt: string
  prompt: string
  tools: NanobotToolDefinition[]
  user_message: Message
  document_id: string
  range_start: number
  range_end: number
  workspace_path: string
  prompt_mode: 'fast-edit' | 'full-agent'
  codex_settings: {
    model?: string
    effort?: ProviderDraft['codex_effort']
    summary?: ProviderDraft['codex_summary']
    service_tier?: string
    sandbox?: ProviderDraft['codex_sandbox']
    approval_policy?: ProviderDraft['codex_approval_policy']
    prompt_mode?: ProviderDraft['codex_prompt_mode']
    tool_mode?: ProviderDraft['codex_tool_mode']
    context_mode?: ProviderDraft['codex_context_mode']
    codex_context_mode?: ProviderDraft['codex_context_mode']
    [key: string]: unknown
  }
  superleaf_context: Record<string, unknown>
  inputs: Record<string, unknown>
}

export interface BrowserClaudePrepare {
  run_id: string
  provider_id: string
  endpoint: string
  model: string
  system_prompt: string
  prompt: string
  tools: NanobotToolDefinition[]
  user_message: Message
  document_id: string
  range_start: number
  range_end: number
  workspace_path: string
  prompt_mode: 'fast-edit' | 'full-agent'
  claude_settings: {
    model?: string
    prompt_mode?: ProviderDraft['claude_prompt_mode']
    tool_mode?: ProviderDraft['claude_tool_mode']
    [key: string]: unknown
  }
  superleaf_context: Record<string, unknown>
  inputs: Record<string, unknown>
}

export interface NanobotToolFunction {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface NanobotToolDefinition {
  type: 'function'
  function: NanobotToolFunction
}

export interface NanobotToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface NanobotChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: NanobotToolCall[]
  tool_call_id?: string
}

export interface BrowserNanobotToolResult {
  role: 'tool'
  tool_call_id: string
  content: string
  failed: boolean
  name: string
  tool_kind: string
  events: Array<{ event: string; data: unknown }>
  model_visible?: Record<string, unknown>
  ui_meta?: Record<string, unknown>
  audit?: Record<string, unknown>
}

export interface MessageInject {
  role: 'agent' | 'user' | 'system'
  content: string
  range_start?: number
  range_end?: number
  error?: string
}

/**
 * Edit proposal emitted by the native Agent's `propose_doc_edit` tool.
 * The backend never applies it; the frontend renders a card and writes
 * through writingStore.applyDocEdit on user accept.
 */

export interface EditProposal {
  proposal_id: string
  document_id: string
  range_start: number
  range_end: number
  original_text: string
  new_text: string
  reason: string
  anchor_text?: string  // Agent 传的 original_text 参数，用于前端文本锚点定位
}

export interface ConversationListQuery {
  document_id?: string
  workflow_id?: string
}

export const conversationApi = {
  list: (query?: ConversationListQuery) => {
    const params = new URLSearchParams()
    if (query?.document_id) params.set('document_id', query.document_id)
    if (query?.workflow_id) params.set('workflow_id', query.workflow_id)
    const qs = params.toString()
    return http<Conversation[]>(`/api/conversations${qs ? `?${qs}` : ''}`)
  },
  create: (body: ConversationCreate) =>
    http<Conversation>('/api/conversations', { method: 'POST', body: JSON.stringify(body) }),
  get: (id: string) => http<Conversation>(`/api/conversations/${encodeURIComponent(id)}`),
  update: (id: string, body: ConversationUpdate) =>
    http<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  delete: (id: string) =>
    http<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listMessages: (conversationId: string) =>
    http<Message[]>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`),
  // sendMessage returns SSE stream URL; caller uses EventSource or fetch.
  sendMessageUrl: (conversationId: string) =>
    `${BASE}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
  injectMessage: (conversationId: string, body: MessageInject) =>
    http<Message>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/inject`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  prepareBrowserNanobot: (conversationId: string, body: MessageSend) =>
    http<BrowserNanobotPrepare>(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser-nanobot/prepare`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  executeBrowserNanobotTool: (
    conversationId: string,
    body: {
      run_id: string
      document_id: string
      range_start: number
      range_end: number
      inputs: Record<string, unknown>
      tool_call: NanobotToolCall
    },
    init?: Pick<HttpInit, 'signal'>,
  ) =>
    http<BrowserNanobotToolResult>(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser-nanobot/tool`,
      { method: 'POST', body: JSON.stringify(body), signal: init?.signal },
    ),
  finishBrowserNanobot: (
    conversationId: string,
    body: { run_id: string; content: string; error?: string },
  ) =>
    http<Message>(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser-nanobot/finish`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  prepareBrowserCodex: (conversationId: string, body: MessageSend) =>
    http<BrowserCodexPrepare>(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser-codex/prepare`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  executeBrowserCodexTool: (
    conversationId: string,
    body: {
      run_id: string
      document_id: string
      range_start: number
      range_end: number
      inputs: Record<string, unknown>
      tool_call: NanobotToolCall
    },
    init?: Pick<HttpInit, 'signal'>,
  ) =>
    http<BrowserNanobotToolResult>(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser-codex/tool`,
      { method: 'POST', body: JSON.stringify(body), signal: init?.signal },
    ),
  finishBrowserCodex: (
    conversationId: string,
    body: { run_id: string; content: string; error?: string; codex_session_id?: string },
  ) =>
    http<Message>(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser-codex/finish`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  prepareBrowserClaude: (conversationId: string, body: MessageSend) =>
    http<BrowserClaudePrepare>(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser-claude/prepare`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  executeBrowserClaudeTool: (
    conversationId: string,
    body: {
      run_id: string
      document_id: string
      range_start: number
      range_end: number
      inputs: Record<string, unknown>
      tool_call: NanobotToolCall
    },
    init?: Pick<HttpInit, 'signal'>,
  ) =>
    http<BrowserNanobotToolResult>(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser-claude/tool`,
      { method: 'POST', body: JSON.stringify(body), signal: init?.signal },
    ),
  finishBrowserClaude: (
    conversationId: string,
    body: { run_id: string; content: string; error?: string; claude_session_id?: string },
  ) =>
    http<Message>(
      `/api/conversations/${encodeURIComponent(conversationId)}/browser-claude/finish`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
}

// ---------------------------------------------------------------------------
// Project members (multi-user collaboration)
// ---------------------------------------------------------------------------

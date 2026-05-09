/**
 * DiscussionTab — chat-style discussions with agents, scoped to current document.
 *
 * UI structure:
 *   - Top: Agent picker (dropdown) + conversation list toggle
 *   - Left/collapsible: Conversation list for (current doc + selected agent)
 *   - Main: Message stream (user/agent turns)
 *   - Bottom: Input box + send button
 *
 * Each conversation is tied to one (document, agent) pair. Switching agents
 * shows that agent's conversations for the current document.
 */

import { useEffect, useMemo, useState } from 'react'
import './discussion.css'
import {
  MessageSquare,
  Plus,
  Send,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react'
import { useConversationStore } from '../../stores/conversationStore'
import type { CachedWorkflow } from '../../services/backendApi'
import type { Conversation, Message } from '../../services/backendApi'

interface DiscussionTabProps {
  workflows: CachedWorkflow[]
  documentId: string | null
  onJumpToRange?: (range: { from: number; to: number }) => void
}

export function DiscussionTab({ workflows, documentId, onJumpToRange }: DiscussionTabProps) {
  const conversations = useConversationStore((s) => s.conversations)
  const messages = useConversationStore((s) => s.messages)
  const streaming = useConversationStore((s) => s.streaming)
  const streamingDelta = useConversationStore((s) => s.streamingDelta)
  const error = useConversationStore((s) => s.error)
  const loadConversations = useConversationStore((s) => s.loadConversations)
  const createConversation = useConversationStore((s) => s.createConversation)
  const deleteConversation = useConversationStore((s) => s.deleteConversation)
  const loadMessages = useConversationStore((s) => s.loadMessages)
  const sendMessage = useConversationStore((s) => s.sendMessage)

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [showConversationList, setShowConversationList] = useState(true)
  const [inputText, setInputText] = useState('')

  // Auto-select first agent if none selected.
  useEffect(() => {
    if (!selectedAgentId && workflows.length > 0) {
      setSelectedAgentId(workflows[0].id)
    }
  }, [selectedAgentId, workflows])

  // Load conversations when document or agent changes.
  useEffect(() => {
    if (documentId && selectedAgentId) {
      loadConversations({ documentId, workflowId: selectedAgentId })
    }
  }, [documentId, selectedAgentId, loadConversations])

  // Filter conversations for current (doc, agent).
  const filteredConversations = useMemo(() => {
    return Object.values(conversations).filter(
      (c) => c.document_id === documentId && c.workflow_id === selectedAgentId,
    )
  }, [conversations, documentId, selectedAgentId])

  // Auto-select first conversation if none active.
  useEffect(() => {
    if (!activeConversationId && filteredConversations.length > 0) {
      setActiveConversationId(filteredConversations[0].id)
    }
  }, [activeConversationId, filteredConversations])

  // Load messages when active conversation changes.
  useEffect(() => {
    if (activeConversationId) {
      loadMessages(activeConversationId)
    }
  }, [activeConversationId, loadMessages])

  const handleNewConversation = async () => {
    if (!documentId || !selectedAgentId) return
    const agent = workflows.find((w) => w.id === selectedAgentId)
    const conv = await createConversation({
      document_id: documentId,
      workflow_id: selectedAgentId,
      title: `与 ${agent?.name ?? 'Agent'} 的对话`,
    })
    if (conv) {
      setActiveConversationId(conv.id)
    }
  }

  const handleDeleteConversation = async (id: string) => {
    if (!confirm('删除这个对话？')) return
    await deleteConversation(id)
    if (activeConversationId === id) {
      setActiveConversationId(null)
    }
  }

  const handleSend = async () => {
    const text = inputText.trim()
    if (!text || !activeConversationId) return
    setInputText('')
    await sendMessage(activeConversationId, { content: text })
  }

  const activeMessages = activeConversationId ? messages[activeConversationId] ?? [] : []
  const isStreaming = activeConversationId ? streaming[activeConversationId] ?? false : false
  const delta = activeConversationId ? streamingDelta[activeConversationId] ?? '' : ''

  if (!documentId) {
    return (
      <div className="tab-empty">
        先打开一个文档，然后就可以和 Agent 讨论了。
      </div>
    )
  }

  if (workflows.length === 0) {
    return (
      <div className="tab-empty">
        还没有配置任何 Agent。去"团队管理" tab 添加供应商和 Agent。
      </div>
    )
  }

  return (
    <div className="discussion-tab">
      <div className="discussion-header">
        <label className="agent-picker-label">
          <span>对话 Agent：</span>
          <select
            value={selectedAgentId ?? ''}
            onChange={(e) => setSelectedAgentId(e.target.value)}
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="ghost-btn small"
          onClick={() => setShowConversationList(!showConversationList)}
          title={showConversationList ? '隐藏对话列表' : '显示对话列表'}
        >
          {showConversationList ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>

      {error && <div className="discussion-error">{error}</div>}

      <div className="discussion-body">
        {showConversationList && (
          <div className="conversation-list">
            <div className="conversation-list-header">
              <span>对话列表 ({filteredConversations.length})</span>
              <button className="ghost-btn small" onClick={handleNewConversation}>
                <Plus size={12} />
              </button>
            </div>
            {filteredConversations.length === 0 && (
              <div className="conversation-empty">
                还没有对话。点击上方 + 创建第一个。
              </div>
            )}
            {filteredConversations.map((conv) => (
              <ConversationCard
                key={conv.id}
                conversation={conv}
                active={conv.id === activeConversationId}
                onClick={() => setActiveConversationId(conv.id)}
                onDelete={() => handleDeleteConversation(conv.id)}
              />
            ))}
          </div>
        )}

        <div className="message-area">
          {!activeConversationId && (
            <div className="message-empty">
              {filteredConversations.length === 0
                ? '点击上方 + 创建新对话'
                : '从左侧选择一个对话'}
            </div>
          )}
          {activeConversationId && (
            <>
              <div className="message-stream">
                {activeMessages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    onJumpToRange={onJumpToRange}
                  />
                ))}
                {isStreaming && delta && (
                  <div className="message-bubble agent streaming">
                    <div className="message-role">Agent</div>
                    <div className="message-content">{delta}</div>
                  </div>
                )}
                {isStreaming && !delta && (
                  <div className="message-bubble agent streaming">
                    <div className="message-role">Agent</div>
                    <div className="message-content">
                      <Loader2 size={14} className="spin" /> 思考中…
                    </div>
                  </div>
                )}
              </div>
              <div className="message-input-row">
                <input
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="输入消息…"
                  disabled={isStreaming}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                />
                <button
                  className="primary-btn"
                  onClick={handleSend}
                  disabled={!inputText.trim() || isStreaming}
                >
                  <Send size={14} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface ConversationCardProps {
  conversation: Conversation
  active: boolean
  onClick: () => void
  onDelete: () => void
}

function ConversationCard({ conversation, active, onClick, onDelete }: ConversationCardProps) {
  return (
    <div className={`conversation-card ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="conversation-card-header">
        <MessageSquare size={12} />
        <span className="conversation-title">{conversation.title || '未命名对话'}</span>
        <button
          className="tree-action-btn"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="删除对话"
        >
          <Trash2 size={10} />
        </button>
      </div>
      {conversation.last_message_preview && (
        <div className="conversation-preview">{conversation.last_message_preview}</div>
      )}
      <div className="conversation-meta">
        {conversation.message_count} 条消息 · {formatTime(conversation.updated_at)}
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message: Message
  onJumpToRange?: (range: { from: number; to: number }) => void
}

function MessageBubble({ message, onJumpToRange }: MessageBubbleProps) {
  const hasRange = message.range_start !== null && message.range_end !== null
  return (
    <div className={`message-bubble ${message.role}`}>
      <div className="message-role">{message.role === 'user' ? '你' : 'Agent'}</div>
      <div className="message-content">{message.content}</div>
      {message.error && <div className="message-error">错误：{message.error}</div>}
      {hasRange && onJumpToRange && (
        <button
          className="message-jump-btn"
          onClick={() =>
            onJumpToRange({ from: message.range_start!, to: message.range_end! })
          }
        >
          ↗ 跳转到原文
        </button>
      )}
      <div className="message-time">{formatTime(message.created_at)}</div>
    </div>
  )
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString()
  return d.toLocaleDateString()
}

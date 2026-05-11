/**
 * DiscussionTab — chat-style discussions with agents, scoped to current document.
 *
 * UI structure (Claude VSCode style):
 *   - Top: Agent picker (dropdown) + conversation history button + new conversation button
 *   - Main: Message stream (full width, no sidebar)
 *   - Bottom: Input box + send button
 *
 * Conversation list is shown in a dropdown menu when clicking the history button.
 */

import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import './discussion.css'
import {
  MessageSquare,
  Plus,
  Send,
  Trash2,
  Loader2,
  History,
  Check,
} from 'lucide-react'
import { useConversationStore } from '../../stores/conversationStore'
import type { CachedWorkflow, Message } from '../../services/backendApi'
import type { Selection } from '../../types/editor'

interface DiscussionTabProps {
  workflows: CachedWorkflow[]
  documentId: string | null
  activeSelection: Selection | null
  onJumpToRange?: (range: { from: number; to: number }) => void
}

export function DiscussionTab({ workflows, documentId, activeSelection, onJumpToRange }: DiscussionTabProps) {
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
    const conv = await createConversation({
      document_id: documentId,
      workflow_id: selectedAgentId,
      title: '新对话',
    })
    if (conv) {
      setActiveConversationId(conv.id)
    }
  }

  const handleDeleteConversation = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
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

    const body: Parameters<typeof sendMessage>[1] = { content: text }
    if (activeSelection && activeSelection.to > activeSelection.from) {
      body.range_start = activeSelection.from
      body.range_end = activeSelection.to
      body.inputs = {
        target_text: activeSelection.text,
        section_title: activeSelection.context.sectionTitle ?? '',
        before: activeSelection.context.before,
        after: activeSelection.context.after,
      }
    }

    await sendMessage(activeConversationId, body)
  }

  const activeMessages = activeConversationId ? messages[activeConversationId] ?? [] : []
  const isStreaming = activeConversationId ? streaming[activeConversationId] ?? false : false
  const delta = activeConversationId ? streamingDelta[activeConversationId] ?? '' : ''
  const activeConversation = activeConversationId
    ? conversations[activeConversationId]
    : null

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
          <span>Agent：</span>
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
        <div className="discussion-header-actions">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                className="ghost-btn small"
                title={`对话历史 (${filteredConversations.length})`}
              >
                <History size={14} />
                <span className="conversation-count">{filteredConversations.length}</span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="conversation-dropdown" sideOffset={5}>
                <div className="conversation-dropdown-header">
                  <span>对话历史</span>
                </div>
                {filteredConversations.length === 0 && (
                  <div className="conversation-dropdown-empty">
                    还没有对话
                  </div>
                )}
                {filteredConversations.map((conv) => (
                  <DropdownMenu.Item
                    key={conv.id}
                    className="conversation-dropdown-item"
                    onSelect={() => setActiveConversationId(conv.id)}
                  >
                    <div className="conversation-dropdown-item-content">
                      <div className="conversation-dropdown-item-header">
                        <MessageSquare size={12} />
                        <span className="conversation-dropdown-title">
                          {conv.title || '未命名对话'}
                        </span>
                        {conv.id === activeConversationId && (
                          <Check size={12} className="active-check" />
                        )}
                      </div>
                      {conv.last_message_preview && (
                        <div className="conversation-dropdown-preview">
                          {conv.last_message_preview}
                        </div>
                      )}
                      <div className="conversation-dropdown-meta">
                        {conv.message_count} 条 · {formatTime(conv.updated_at)}
                      </div>
                    </div>
                    <button
                      className="conversation-dropdown-delete"
                      onClick={(e) => handleDeleteConversation(conv.id, e)}
                      title="删除对话"
                    >
                      <Trash2 size={10} />
                    </button>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button
            className="ghost-btn small"
            onClick={handleNewConversation}
            title="新建对话"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {error && <div className="discussion-error">{error}</div>}

      {activeConversation && (
        <div className="active-conversation-indicator">
          <MessageSquare size={12} />
          <span>{activeConversation.title || '未命名对话'}</span>
        </div>
      )}

      <div className="discussion-body-compact">
        <div className="message-area-full">
          {!activeConversationId && (
            <div className="message-empty">
              {filteredConversations.length === 0
                ? '点击右上角 + 创建新对话'
                : '从右上角历史按钮选择一个对话'}
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
                {activeSelection && activeSelection.to > activeSelection.from && (
                  <div
                    className="discussion-selection-chip"
                    title={activeSelection.text}
                    onClick={() =>
                      onJumpToRange?.({
                        from: activeSelection.from,
                        to: activeSelection.to,
                      })
                    }
                  >
                    <span className="chip-label">选区已附带</span>
                    <span className="chip-preview">
                      {activeSelection.text.length > 40
                        ? `${activeSelection.text.slice(0, 40)}…`
                        : activeSelection.text}
                    </span>
                    <span className="chip-range">
                      {activeSelection.from}–{activeSelection.to}
                    </span>
                  </div>
                )}
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

interface MessageBubbleProps {
  message: Message
  onJumpToRange?: (range: { from: number; to: number }) => void
}

function MessageBubble({ message, onJumpToRange }: MessageBubbleProps) {
  const hasRange = message.range_start !== null && message.range_end !== null
  return (
    <div className={`message-bubble ${message.role}`}>
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

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
  X,
} from 'lucide-react'
import { useConversationStore } from '../../stores/conversationStore'
import { useFilesystemStore } from '../../stores/filesystemStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import type { CachedWorkflow, Message } from '../../services/backendApi'
import type { Selection } from '../../types/editor'
import {
  parseMentions,
  stripMentions,
  flattenFileCandidates,
  sortFilesCurrentFirst,
  uniqueMentionedFiles,
  uniqueMentionedWorkflows,
  resolveAttachedFiles,
  type AgentCandidate,
  type FileCandidate,
  type MentionCandidate,
  type WorkflowCandidate,
} from '../../services/mentions'
import { MentionInput } from '../shared/MentionInput'
import { confirmLargeFileAttachment } from '../shared/fileSizeGate'
import { AgentMarkdown } from '../shared/AgentMarkdown'

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
  const injectMessage = useConversationStore((s) => s.injectMessage)
  const executeDefinition = useWorkflowStore((s) => s.executeDefinition)

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [inputText, setInputText] = useState('')

  const tree = useFilesystemStore((s) => s.tree)
  const definitions = useWorkflowStore((s) => s.definitions)
  const fileCandidates = useMemo(
    () => sortFilesCurrentFirst(flattenFileCandidates(tree), documentId),
    [tree, documentId],
  )
  const agentCandidates: AgentCandidate[] = useMemo(
    () => workflows.map((w) => ({ kind: 'agent', id: w.id, name: w.name })),
    [workflows],
  )
  const workflowCandidates: WorkflowCandidate[] = useMemo(
    () =>
      definitions.map((d) => ({
        kind: 'workflow',
        id: d.id,
        name: d.name,
        description: d.description ?? undefined,
      })),
    [definitions],
  )
  const allCandidates: MentionCandidate[] = useMemo(
    () => [...agentCandidates, ...workflowCandidates, ...fileCandidates],
    [agentCandidates, workflowCandidates, fileCandidates],
  )

  // Files the user has @-mentioned in the current draft (for chip row preview).
  const pendingFileMentions = useMemo(() => {
    if (!inputText.trim()) return [] as FileCandidate[]
    const mentions = parseMentions(inputText, allCandidates)
    return uniqueMentionedFiles(mentions)
  }, [inputText, allCandidates])

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
    const rawText = inputText.trim()
    if (!rawText || !activeConversationId) return

    const mentions = parseMentions(rawText, allCandidates)
    const cleanedText = stripMentions(rawText, mentions) || rawText
    const mentionedFiles = uniqueMentionedFiles(mentions)
    const mentionedWorkflows = uniqueMentionedWorkflows(mentions)
    const attachedFiles = await resolveAttachedFiles(mentionedFiles, {
      onFetchError: (file) =>
        console.warn('[DiscussionTab] failed to fetch file', file.path),
    })

    setInputText('')

    // Build selection + attached-file context once; reused by both the agent
    // send path and any workflow dispatch.
    const inputs: Record<string, unknown> = {}
    const body: Parameters<typeof sendMessage>[1] = { content: cleanedText }
    if (activeSelection && activeSelection.to > activeSelection.from) {
      body.range_start = activeSelection.from
      body.range_end = activeSelection.to
      inputs.target_text = activeSelection.text
      inputs.section_title = activeSelection.context.sectionTitle ?? ''
      inputs.before = activeSelection.context.before
      inputs.after = activeSelection.context.after
    }
    if (attachedFiles.length > 0) {
      inputs.attached_files = attachedFiles
    }
    if (Object.keys(inputs).length > 0) {
      body.inputs = inputs
    }

    // If the user only @-mentioned workflows (no fresh agent question),
    // dispatch workflow(s) without routing through sendMessage. Otherwise
    // the Agent picker path runs normally AND any @workflow mentions fan out.
    await sendMessage(activeConversationId, body)

    if (mentionedWorkflows.length > 0 && documentId) {
      await Promise.all(
        mentionedWorkflows.map((wf) =>
          dispatchWorkflowToConversation({
            workflow: wf,
            conversationId: activeConversationId,
            documentId,
            selection: activeSelection,
            attachedFiles,
            query: cleanedText,
            executeDefinition,
            injectMessage,
          }),
        ),
      )
    }
  }

  const removeFileMention = (fileId: string) => {
    const mentions = parseMentions(inputText, allCandidates)
    // Walk in reverse so offsets stay valid as we delete.
    const targets = [...mentions]
      .filter((m) => m.candidate.kind === 'file' && m.candidate.id === fileId)
      .sort((a, b) => b.start - a.start)
    let next = inputText
    for (const m of targets) {
      next = next.slice(0, m.start) + next.slice(m.end)
    }
    setInputText(next.replace(/\s{2,}/g, ' '))
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
                    <AgentMarkdown source={delta} className="message-content" />
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
                {pendingFileMentions.length > 0 && (
                  <div className="discussion-attached-chips">
                    {pendingFileMentions.map((f) => (
                      <div key={f.id} className="discussion-attached-chip" title={f.path}>
                        <span className="chip-label">附件</span>
                        <span className="chip-preview">{f.name}</span>
                        <button
                          className="chip-remove"
                          title="移除该附件"
                          onClick={() => removeFileMention(f.id)}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <MentionInput
                  value={inputText}
                  onChange={setInputText}
                  agents={agentCandidates}
                  workflows={workflowCandidates}
                  files={fileCandidates}
                  placeholder="输入消息，用 @ 召唤 Agent / Workflow 或引用文件…"
                  disabled={isStreaming}
                  rows={2}
                  onCandidatePicked={(c) =>
                    c.kind === 'file' ? confirmLargeFileAttachment(c) : true
                  }
                  onSubmit={handleSend}
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
      {message.role === 'agent' ? (
        <AgentMarkdown source={message.content} className="message-content" />
      ) : (
        <div className="message-content">{message.content}</div>
      )}
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

/**
 * Run a workflow definition out-of-band and deposit its summary into the
 * active conversation as a synthetic agent message. Failures are captured
 * via the same injection channel so the user can see why the run collapsed
 * without leaving the discussion surface.
 */
async function dispatchWorkflowToConversation({
  workflow,
  conversationId,
  documentId,
  selection,
  attachedFiles,
  query,
  executeDefinition,
  injectMessage,
}: {
  workflow: WorkflowCandidate
  conversationId: string
  documentId: string
  selection: Selection | null
  attachedFiles: Awaited<ReturnType<typeof resolveAttachedFiles>>
  query: string
  executeDefinition: ReturnType<typeof useWorkflowStore.getState>['executeDefinition']
  injectMessage: ReturnType<typeof useConversationStore.getState>['injectMessage']
}): Promise<void> {
  const rangeStart = selection && selection.to > selection.from ? selection.from : 0
  const rangeEnd = selection && selection.to > selection.from ? selection.to : 0
  const targetText = selection?.text ?? ''

  await executeDefinition(
    workflow.id,
    {
      document_id: documentId,
      range_start: rangeStart,
      range_end: rangeEnd,
      inputs: {
        target_text: targetText,
        user_message: query,
        text: targetText,
        attached_files: attachedFiles,
      },
      query,
    },
    {
      autoIngestToAnnotations: false,
      onCompleted: async (summary) => {
        const body = summary && summary.trim() ? summary.trim() : `（${workflow.name} 已运行完毕，未产出摘要文本）`
        await injectMessage(conversationId, {
          role: 'agent',
          content: `【Workflow · ${workflow.name}】\n${body}`,
          range_start: selection && selection.to > selection.from ? selection.from : undefined,
          range_end: selection && selection.to > selection.from ? selection.to : undefined,
        })
      },
      onFailed: async (err) => {
        await injectMessage(conversationId, {
          role: 'agent',
          content: `【Workflow · ${workflow.name}】运行失败`,
          error: err,
        })
      },
    },
  )
}

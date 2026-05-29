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

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
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
  Pencil,
  Pin,
  PinOff,
  Lock,
  Unlock,
  GripVertical,
} from 'lucide-react'
import { useConversationStore } from '../../stores/conversationStore'
import { useFilesystemStore } from '../../stores/filesystemStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { CachedWorkflow, Conversation, Message } from '../../services/backendApi'
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

const USER_MESSAGE_PREVIEW_CHAR_LIMIT = 260
const USER_MESSAGE_PREVIEW_LINE_LIMIT = 6

export function DiscussionTab({ workflows, documentId, activeSelection, onJumpToRange }: DiscussionTabProps) {
  const conversations = useConversationStore((s) => s.conversations)
  const messages = useConversationStore((s) => s.messages)
  const streaming = useConversationStore((s) => s.streaming)
  const streamingDelta = useConversationStore((s) => s.streamingDelta)
  const error = useConversationStore((s) => s.error)
  const loadConversations = useConversationStore((s) => s.loadConversations)
  const createConversation = useConversationStore((s) => s.createConversation)
  const renameConversation = useConversationStore((s) => s.renameConversation)
  const togglePinConversation = useConversationStore((s) => s.togglePinConversation)
  const pinAtCurrentPosition = useConversationStore((s) => s.pinAtCurrentPosition)
  const releaseFixedPosition = useConversationStore((s) => s.releaseFixedPosition)
  const reorderConversation = useConversationStore((s) => s.reorderConversation)
  const deleteConversation = useConversationStore((s) => s.deleteConversation)
  const loadMessages = useConversationStore((s) => s.loadMessages)
  const sendMessage = useConversationStore((s) => s.sendMessage)
  const injectMessage = useConversationStore((s) => s.injectMessage)
  const executeDefinition = useWorkflowStore((s) => s.executeDefinition)
  const activeDocFormat = useDocumentStore((s) =>
    documentId ? s.documents[documentId]?.format : undefined,
  )
  const providers = useSettingsStore((s) => s.providers)

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [manualConversation, setManualConversation] = useState<{
    scopeKey: string
    id: string
  } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const messageStreamRef = useRef<HTMLDivElement | null>(null)

  const tree = useFilesystemStore((s) => s.tree)
  const definitions = useWorkflowStore((s) => s.definitions)
  const fileCandidates = useMemo(
    () => sortFilesCurrentFirst(flattenFileCandidates(tree), documentId),
    [tree, documentId],
  )
  const providerNamesById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.name])),
    [providers],
  )
  const agentCandidates: AgentCandidate[] = useMemo(
    () =>
      workflows.map((w) => ({
        kind: 'agent',
        id: w.id,
        name: w.name,
        displayName: formatAgentDisplayName(w, providerNamesById),
      })),
    [workflows, providerNamesById],
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
  const validSelectedAgentId = useMemo(
    () =>
      selectedAgentId && workflows.some((w) => w.id === selectedAgentId)
        ? selectedAgentId
        : workflows[0]?.id ?? null,
    [selectedAgentId, workflows],
  )
  const conversationScopeKey = `${documentId ?? ''}::${validSelectedAgentId ?? ''}`

  // Load conversations when document or agent changes.
  useEffect(() => {
    if (!documentId || !validSelectedAgentId) return
    loadConversations({ documentId, workflowId: validSelectedAgentId })
  }, [documentId, validSelectedAgentId, loadConversations])

  // Filter conversations for current (doc, agent).
  const filteredConversations = useMemo(() => {
    return Object.values(conversations)
      .filter((c) => c.document_id === documentId && c.workflow_id === validSelectedAgentId)
      .sort(compareConversationsNewestFirst)
  }, [conversations, documentId, validSelectedAgentId])

  const activeConversationIdForRender =
    manualConversation?.scopeKey === conversationScopeKey &&
    filteredConversations.some((c) => c.id === manualConversation.id)
      ? manualConversation.id
      : null
  const effectiveConversationId = activeConversationIdForRender ?? filteredConversations[0]?.id ?? null

  // Load messages when active conversation changes.
  useEffect(() => {
    if (effectiveConversationId) {
      loadMessages(effectiveConversationId)
    }
  }, [effectiveConversationId, loadMessages])

  const handleNewConversation = async () => {
    if (!documentId || !validSelectedAgentId) return
    const conv = await createConversation({
      document_id: documentId,
      workflow_id: validSelectedAgentId,
      title: '新对话',
    })
    if (conv) {
      setManualConversation({ scopeKey: conversationScopeKey, id: conv.id })
    }
  }

  const handleDeleteConversation = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!confirm('删除这个对话？')) return
    await deleteConversation(id)
    if (effectiveConversationId === id) {
      setManualConversation(null)
    }
  }

  const handleStartRename = (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation()
    setRenamingId(conv.id)
    setRenameText(conv.title || '')
  }

  const handleCommitRename = async (id: string) => {
    const trimmed = renameText.trim()
    if (trimmed) {
      await renameConversation(id, trimmed)
    }
    setRenamingId(null)
  }

  const handleCancelRename = () => {
    setRenamingId(null)
  }

  // Long-press to drag (250ms) so a normal click still selects/opens the conversation.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  )

  const handleTogglePin = (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation()
    void togglePinConversation(conv.id, !conv.is_pinned)
  }

  const handleToggleFixed = (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation()
    if (conv.sort_index !== null) {
      void releaseFixedPosition(conv.id)
    } else {
      // Snapshot current updated_at as the fixed sort key.
      void pinAtCurrentPosition(conv.id, timestampValue(conv.updated_at))
    }
  }

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const list = filteredConversations
    const oldIdx = list.findIndex((c) => c.id === active.id)
    const newIdx = list.findIndex((c) => c.id === over.id)
    if (oldIdx === -1 || newIdx === -1) return
    const reordered = arrayMove(list, oldIdx, newIdx)
    const moved = reordered[newIdx]
    // Pin group is preserved: cross-group drags fall back to entering the group of the drop target.
    const targetGroupPinned = list[newIdx].is_pinned
    // Compute fractional sort_index between the two neighbours within the same group.
    const sameGroup = (c: Conversation) => c.is_pinned === targetGroupPinned
    const groupItems = reordered.filter(sameGroup)
    const groupPos = groupItems.findIndex((c) => c.id === moved.id)
    const above = groupItems[groupPos - 1]
    const below = groupItems[groupPos + 1]
    const aboveKey = above ? (above.sort_index ?? timestampValue(above.updated_at)) : null
    const belowKey = below ? (below.sort_index ?? timestampValue(below.updated_at)) : null
    let nextIndex: number
    if (aboveKey === null && belowKey !== null) nextIndex = belowKey + 1
    else if (aboveKey !== null && belowKey === null) nextIndex = aboveKey - 1
    else if (aboveKey !== null && belowKey !== null) nextIndex = (aboveKey + belowKey) / 2
    else nextIndex = timestampValue(moved.updated_at)
    void reorderConversation(moved.id, nextIndex, targetGroupPinned)
  }

  const handleSend = useCallback(async (rawText: string) => {
    if (!rawText || !effectiveConversationId) return

    const mentions = parseMentions(rawText, allCandidates)
    const cleanedText = stripMentions(rawText, mentions) || rawText
    const mentionedFiles = uniqueMentionedFiles(mentions)
    const mentionedWorkflows = uniqueMentionedWorkflows(mentions)
    const attachedFiles = await resolveAttachedFiles(mentionedFiles, {
      onFetchError: (file) =>
        console.warn('[DiscussionTab] failed to fetch file', file.path),
    })

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
    if (activeDocFormat) {
      inputs.doc_format = activeDocFormat
    }
    if (attachedFiles.length > 0) {
      inputs.attached_files = attachedFiles
    }
    if (Object.keys(inputs).length > 0) {
      body.inputs = inputs
    }

    await sendMessage(effectiveConversationId, body)

    if (mentionedWorkflows.length > 0 && documentId) {
      await Promise.all(
        mentionedWorkflows.map((wf) =>
          dispatchWorkflowToConversation({
            workflow: wf,
            conversationId: effectiveConversationId,
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
  }, [effectiveConversationId, allCandidates, activeSelection, activeDocFormat, sendMessage, documentId, executeDefinition, injectMessage])

  const activeMessages = effectiveConversationId ? messages[effectiveConversationId] ?? [] : []
  const isStreaming = effectiveConversationId ? streaming[effectiveConversationId] ?? false : false
  const delta = effectiveConversationId ? streamingDelta[effectiveConversationId] ?? '' : ''
  const activeConversation = effectiveConversationId
    ? conversations[effectiveConversationId]
    : null
  const activeAgentName = useMemo(() => {
    const agent = workflows.find((w) => w.id === validSelectedAgentId)
    return agent?.name ?? 'Agent'
  }, [workflows, validSelectedAgentId])

  useEffect(() => {
    const el = messageStreamRef.current
    if (!el) return
    const scrollToBottom = () => {
      el.scrollTop = el.scrollHeight
    }
    const frame = window.requestAnimationFrame(scrollToBottom)
    const timer = window.setTimeout(scrollToBottom, 80)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [effectiveConversationId, activeMessages.length, delta, isStreaming])

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
            value={validSelectedAgentId ?? ''}
            onChange={(e) => {
              setSelectedAgentId(e.target.value || null)
              setManualConversation(null)
            }}
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {formatAgentDisplayName(w, providerNamesById)}
              </option>
            ))}
          </select>
        </label>
        <div className="discussion-header-actions">
          <DropdownMenu.Root open={historyOpen} onOpenChange={setHistoryOpen}>
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
                <DndContext
                  sensors={dndSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={filteredConversations.map((c) => c.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {filteredConversations.map((conv) => (
                      <SortableConversationItem
                        key={conv.id}
                        conv={conv}
                        active={conv.id === effectiveConversationId}
                        renamingId={renamingId}
                        renameText={renameText}
                        onRenameTextChange={setRenameText}
                        onSelect={() => {
                          setManualConversation({ scopeKey: conversationScopeKey, id: conv.id })
                          setHistoryOpen(false)
                        }}
                        onStartRename={handleStartRename}
                        onCommitRename={handleCommitRename}
                        onCancelRename={handleCancelRename}
                        onDelete={handleDeleteConversation}
                        onTogglePin={handleTogglePin}
                        onToggleFixed={handleToggleFixed}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
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
          {!effectiveConversationId && (
            <div className="message-empty">
              {filteredConversations.length === 0
                ? '点击右上角 + 创建新对话'
                : '从右上角历史按钮选择一个对话'}
            </div>
          )}
          {effectiveConversationId && (
            <>
              <div className="message-stream" ref={messageStreamRef}>
                {activeMessages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    agentDisplayName={activeAgentName}
                    onJumpToRange={onJumpToRange}
                  />
                ))}
                {isStreaming && delta && (
                  <div className="message-bubble agent streaming">
                    <div className="message-role">{activeAgentName}</div>
                    <AgentMarkdown source={delta} className="message-content" />
                  </div>
                )}
                {isStreaming && !delta && (
                  <div className="message-bubble agent streaming">
                    <div className="message-role">{activeAgentName}</div>
                    <div className="message-content">
                      <Loader2 size={14} className="spin" /> 思考中…
                    </div>
                  </div>
                )}
              </div>
              <DiscussionComposer
                allCandidates={allCandidates}
                agentCandidates={agentCandidates}
                workflowCandidates={workflowCandidates}
                fileCandidates={fileCandidates}
                activeSelection={activeSelection}
                isStreaming={isStreaming}
                onSend={handleSend}
                onJumpToRange={onJumpToRange}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message: Message
  agentDisplayName: string
  onJumpToRange?: (range: { from: number; to: number }) => void
}

interface DiscussionComposerProps {
  allCandidates: MentionCandidate[]
  agentCandidates: AgentCandidate[]
  workflowCandidates: WorkflowCandidate[]
  fileCandidates: FileCandidate[]
  activeSelection: Selection | null
  isStreaming: boolean
  onSend: (rawText: string) => void
  onJumpToRange?: (range: { from: number; to: number }) => void
}

const DiscussionComposer = memo(function DiscussionComposer({
  allCandidates,
  agentCandidates,
  workflowCandidates,
  fileCandidates,
  activeSelection,
  isStreaming,
  onSend,
  onJumpToRange,
}: DiscussionComposerProps) {
  const [inputText, setInputText] = useState('')

  const pendingFileMentions = useMemo(() => {
    if (!inputText.includes('@')) return [] as FileCandidate[]
    const mentions = parseMentions(inputText, allCandidates)
    return uniqueMentionedFiles(mentions)
  }, [inputText, allCandidates])

  const removeFileMention = (fileId: string) => {
    const mentions = parseMentions(inputText, allCandidates)
    const targets = [...mentions]
      .filter((m) => m.candidate.kind === 'file' && m.candidate.id === fileId)
      .sort((a, b) => b.start - a.start)
    let next = inputText
    for (const m of targets) {
      next = next.slice(0, m.start) + next.slice(m.end)
    }
    setInputText(next.replace(/\s{2,}/g, ' '))
  }

  const handleSubmit = () => {
    const raw = inputText.trim()
    if (!raw) return
    onSend(raw)
    setInputText('')
  }

  return (
    <div className="message-input-row">
      {activeSelection && activeSelection.to > activeSelection.from && (
        <div
          className="discussion-selection-chip"
          title={activeSelection.text}
          onClick={() =>
            onJumpToRange?.({ from: activeSelection.from, to: activeSelection.to })
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
        autoResize
        className="discussion-mention-input"
        menuPlacement="composer-panel"
        onCandidatePicked={(c) =>
          c.kind === 'file' ? confirmLargeFileAttachment(c) : true
        }
        onSubmit={handleSubmit}
      />
      <button
        className="primary-btn"
        onClick={handleSubmit}
        disabled={!inputText.trim() || isStreaming}
      >
        <Send size={14} />
      </button>
    </div>
  )
})

interface SortableConversationItemProps {
  conv: Conversation
  active: boolean
  renamingId: string | null
  renameText: string
  onRenameTextChange: (next: string) => void
  onSelect: () => void
  onStartRename: (conv: Conversation, e: React.MouseEvent) => void
  onCommitRename: (id: string) => void
  onCancelRename: () => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onTogglePin: (conv: Conversation, e: React.MouseEvent) => void
  onToggleFixed: (conv: Conversation, e: React.MouseEvent) => void
}

function SortableConversationItem({
  conv,
  active,
  renamingId,
  renameText,
  onRenameTextChange,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
  onTogglePin,
  onToggleFixed,
}: SortableConversationItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: conv.id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  const isRenaming = renamingId === conv.id
  const isFixed = conv.sort_index !== null

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`conversation-dropdown-item ${active ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${conv.is_pinned ? 'pinned' : ''}`}
      onClick={() => {
        if (isRenaming) return
        onSelect()
      }}
    >
      <button
        className="conversation-drag-handle"
        title="长按拖动调整顺序"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical size={12} />
      </button>
      <div className="conversation-dropdown-item-content">
        {isRenaming ? (
          <div className="conversation-rename-row" onClick={(e) => e.stopPropagation()}>
            <input
              className="conversation-rename-input"
              value={renameText}
              onChange={(e) => onRenameTextChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); onCommitRename(conv.id) }
                if (e.key === 'Escape') { e.preventDefault(); onCancelRename() }
              }}
              autoFocus
            />
            <button
              className="conversation-rename-confirm"
              onClick={() => onCommitRename(conv.id)}
              title="确认"
            >
              <Check size={11} />
            </button>
            <button
              className="conversation-rename-cancel"
              onClick={onCancelRename}
              title="取消"
            >
              <X size={11} />
            </button>
          </div>
        ) : (
          <>
            <div className="conversation-dropdown-item-header">
              <MessageSquare size={12} />
              <span className="conversation-dropdown-title">
                {conv.title || '未命名对话'}
              </span>
              {active && <Check size={12} className="active-check" />}
            </div>
            {conv.last_message_preview && (
              <div className="conversation-dropdown-preview">
                {conv.last_message_preview}
              </div>
            )}
            <div className="conversation-dropdown-meta">
              {conv.message_count} 条 · {formatTime(conv.updated_at)}
            </div>
          </>
        )}
      </div>
      {!isRenaming && (
        <div className="conversation-dropdown-actions">
          <button
            className={`conversation-dropdown-pin ${conv.is_pinned ? 'on' : ''}`}
            onClick={(e) => onTogglePin(conv, e)}
            title={conv.is_pinned ? '取消置顶' : '置顶'}
          >
            {conv.is_pinned ? <PinOff size={10} /> : <Pin size={10} />}
          </button>
          <button
            className={`conversation-dropdown-fix ${isFixed ? 'on' : ''}`}
            onClick={(e) => onToggleFixed(conv, e)}
            title={isFixed ? '解除固定位置' : '固定在当前位置'}
          >
            {isFixed ? <Unlock size={10} /> : <Lock size={10} />}
          </button>
          <button
            className="conversation-dropdown-rename"
            onClick={(e) => onStartRename(conv, e)}
            title="重命名"
          >
            <Pencil size={10} />
          </button>
          <button
            className="conversation-dropdown-delete"
            onClick={(e) => onDelete(conv.id, e)}
            title="删除对话"
          >
            <Trash2 size={10} />
          </button>
        </div>
      )}
    </div>
  )
}

function MessageBubble({ message, agentDisplayName, onJumpToRange }: MessageBubbleProps) {
  const hasRange = message.range_start !== null && message.range_end !== null
  return (
    <div className={`message-bubble ${message.role}`}>
      {message.role === 'agent' ? (
        <>
          <div className="message-role">{agentDisplayName}</div>
          <AgentMarkdown source={message.content} className="message-content" />
        </>
      ) : message.role === 'user' ? (
        <UserMessageContent content={message.content} />
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

function UserMessageContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const preview = useMemo(() => createUserMessagePreview(content), [content])
  const collapsible = preview !== content

  if (!collapsible) {
    return <div className="message-content">{content}</div>
  }

  return (
    <button
      type="button"
      className={`message-content user-message-content ${
        expanded ? 'is-expanded' : 'is-collapsed'
      }`}
      onClick={() => setExpanded((value) => !value)}
      aria-expanded={expanded}
      aria-label={expanded ? '收起完整输入' : '展开完整输入'}
      title={expanded ? '收起完整输入' : '展开完整输入'}
    >
      {expanded ? content : preview}
    </button>
  )
}

function createUserMessagePreview(content: string): string {
  const lines = content.split(/\r\n|\r|\n/)
  const lineLimited =
    lines.length > USER_MESSAGE_PREVIEW_LINE_LIMIT
      ? lines.slice(0, USER_MESSAGE_PREVIEW_LINE_LIMIT).join('\n')
      : content
  const chars = Array.from(lineLimited)
  const charLimited =
    chars.length > USER_MESSAGE_PREVIEW_CHAR_LIMIT
      ? chars.slice(0, USER_MESSAGE_PREVIEW_CHAR_LIMIT).join('')
      : lineLimited
  const preview = charLimited.trimEnd()
  return preview === content ? content : `${preview}…`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString()
  return d.toLocaleDateString()
}

function compareConversationsNewestFirst(a: Conversation, b: Conversation): number {
  if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
  const ka = a.sort_index ?? timestampValue(a.updated_at)
  const kb = b.sort_index ?? timestampValue(b.updated_at)
  return (
    kb - ka ||
    timestampValue(b.created_at) - timestampValue(a.created_at) ||
    b.id.localeCompare(a.id)
  )
}

function formatAgentDisplayName(
  agent: Pick<CachedWorkflow, 'id' | 'provider_id' | 'name'>,
  providerNamesById: ReadonlyMap<string, string>,
): string {
  const providerName = providerNamesById.get(agent.provider_id)?.trim()
  return `${agent.name} (${providerName || shortAgentId(agent.id)})`
}

function shortAgentId(id: string): string {
  return id.trim().slice(0, 5) || '-----'
}

function timestampValue(iso: string): number {
  const value = new Date(iso).getTime()
  return Number.isFinite(value) ? value : 0
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

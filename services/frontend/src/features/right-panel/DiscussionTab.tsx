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

import { useCallback, useEffect, useMemo, useRef, useState, memo, Fragment } from 'react'
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
  Square,
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
  FileEdit,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { useConversationStore } from '../../stores/conversationStore'
import type { AgentRunStats, LocalAgentApprovalEntry, ProposalEntry } from '../../stores/conversationStore'
import { useFilesystemStore } from '../../stores/filesystemStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { CachedWorkflow, Conversation, Message } from '../../services/backendApi'
import type { Selection } from '../../types/editor'
import {
  parseMentions,
  segmentText,
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
import {
  conversationScopeKey as buildConversationScopeKey,
  documentConversationsNewestFirst,
  enabledDiscussionAgents,
  resolveDiscussionAgentId,
  timestampValue,
  type SelectedAgentByDocument,
} from './discussionAgentSelection'

interface DiscussionTabProps {
  workflows: CachedWorkflow[]
  documentId: string | null
  activeSelection: Selection | null
  selectedAgentByDocument: SelectedAgentByDocument
  onSelectAgentForDocument: (documentId: string, workflowId: string) => void
  onJumpToRange?: (range: { from: number; to: number }) => void
}

const USER_MESSAGE_PREVIEW_CHAR_LIMIT = 260
const USER_MESSAGE_PREVIEW_LINE_LIMIT = 6

export function DiscussionTab({
  workflows,
  documentId,
  activeSelection,
  selectedAgentByDocument,
  onSelectAgentForDocument,
  onJumpToRange,
}: DiscussionTabProps) {
  const conversations = useConversationStore((s) => s.conversations)
  const messages = useConversationStore((s) => s.messages)
  const streaming = useConversationStore((s) => s.streaming)
  const streamingDelta = useConversationStore((s) => s.streamingDelta)
  const streamingStats = useConversationStore((s) => s.streamingStats)
  const messageRunStats = useConversationStore((s) => s.messageRunStats)
  const error = useConversationStore((s) => s.error)
  const proposalsByConv = useConversationStore((s) => s.proposals)
  const localApprovalsByConv = useConversationStore((s) => s.localApprovals)
  const acceptProposal = useConversationStore((s) => s.acceptProposal)
  const rejectProposal = useConversationStore((s) => s.rejectProposal)
  const submitLocalApproval = useConversationStore((s) => s.submitLocalApproval)
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
  const stopMessage = useConversationStore((s) => s.stopMessage)
  const injectMessage = useConversationStore((s) => s.injectMessage)
  const executeDefinition = useWorkflowStore((s) => s.executeDefinition)
  const activeDocFormat = useDocumentStore((s) =>
    documentId ? s.documents[documentId]?.format : undefined,
  )
  const providers = useSettingsStore((s) => s.providers)

  const [manualConversation, setManualConversation] = useState<{
    scopeKey: string
    id: string
  } | null>(null)
  const [loadedConversationDocumentId, setLoadedConversationDocumentId] =
    useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  // Per-proposal collapsed state. New cards default to expanded; a user
  // composing a new message collapses every existing card so the chat tail
  // stays readable.
  const [collapsedProposals, setCollapsedProposals] = useState<
    Record<string, boolean>
  >({})
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
  const activeProviderId = useMemo(
    () => providers.find((provider) => provider.is_active)?.id ?? null,
    [providers],
  )
  const availableWorkflows = useMemo(
    () => enabledDiscussionAgents(workflows),
    [workflows],
  )
  const agentCandidates: AgentCandidate[] = useMemo(
    () =>
      availableWorkflows.map((w) => ({
        kind: 'agent',
        id: w.id,
        name: w.name,
        displayName: formatAgentDisplayName(w, providerNamesById),
      })),
    [availableWorkflows, providerNamesById],
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
  const conversationsReadyForDocument = loadedConversationDocumentId === documentId
  const conversationList = useMemo(
    () => (conversationsReadyForDocument ? Object.values(conversations) : []),
    [conversations, conversationsReadyForDocument],
  )
  const documentConversations = useMemo(
    () => documentConversationsNewestFirst(conversationList, documentId, availableWorkflows),
    [conversationList, documentId, availableWorkflows],
  )
  const validSelectedAgentId = useMemo(
    () => {
      const manualAgentId = documentId ? selectedAgentByDocument[documentId] : undefined
      const manualAgentIsAvailable = availableWorkflows.some(
        (workflow) => workflow.id === manualAgentId,
      )
      if (!conversationsReadyForDocument && !manualAgentIsAvailable) return null
      return resolveDiscussionAgentId({
        documentId,
        workflows,
        conversations: conversationList,
        selectedAgentByDocument,
        activeProviderId,
      })
    },
    [
      documentId,
      workflows,
      availableWorkflows,
      conversationList,
      selectedAgentByDocument,
      activeProviderId,
      conversationsReadyForDocument,
    ],
  )
  const currentConversationScopeKey = buildConversationScopeKey(
    documentId,
    validSelectedAgentId,
  )

  // Load all conversations for the current document so Agent choice can be
  // restored from the document's previous discussion, regardless of Agent.
  useEffect(() => {
    if (!documentId) return
    let cancelled = false
    void loadConversations({ documentId }).then(() => {
      if (!cancelled) setLoadedConversationDocumentId(documentId)
    })
    return () => {
      cancelled = true
    }
  }, [documentId, loadConversations])

  // The message stream stays scoped to the selected Agent; the history menu
  // shows every enabled Agent discussion for the document.
  const filteredConversations = useMemo(() => {
    return documentConversations.filter((c) => c.workflow_id === validSelectedAgentId)
  }, [documentConversations, validSelectedAgentId])

  const activeConversationIdForRender =
    manualConversation?.scopeKey === currentConversationScopeKey &&
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
      setManualConversation({ scopeKey: currentConversationScopeKey, id: conv.id })
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
    const list = documentConversations
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
    // Keep the raw mention markers in the message body so the bubble can
    // render them with the same colored highlight the input box uses. The
    // backend gets attached_files via inputs separately, so the markers in
    // the text are purely a human-readable trace of what the user invoked.
    const mentionedFiles = uniqueMentionedFiles(mentions)
    const mentionedWorkflows = uniqueMentionedWorkflows(mentions)
    const attachedFiles = await resolveAttachedFiles(mentionedFiles, {
      onFetchError: (file) =>
        console.warn('[DiscussionTab] failed to fetch file', file.path),
    })

    const inputs: Record<string, unknown> = {}
    const body: Parameters<typeof sendMessage>[1] = { content: rawText }
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
      // Workflow dispatch still uses a clean query (no @markers), since the
      // workflow runner treats the query as a literal instruction.
      const cleanedQuery = stripMentions(rawText, mentions) || rawText
      await Promise.all(
        mentionedWorkflows.map((wf) =>
          dispatchWorkflowToConversation({
            workflow: wf,
            conversationId: effectiveConversationId,
            documentId,
            selection: activeSelection,
            attachedFiles,
            query: cleanedQuery,
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
  const activeStreamingStats = effectiveConversationId
    ? streamingStats[effectiveConversationId]
    : undefined
  const activeProposals = useMemo(
    () => (effectiveConversationId ? proposalsByConv[effectiveConversationId] ?? [] : []),
    [effectiveConversationId, proposalsByConv],
  )
  const activeLocalApprovals = effectiveConversationId
    ? localApprovalsByConv[effectiveConversationId] ?? []
    : []
  // Group proposals by their parent agent message. Proposals that arrived
  // mid-stream have message_id === '' and live under the streaming bubble
  // until ylw.msg.finished promotes them to the new message id.
  const proposalsByMessage = useMemo(() => {
    const map = new Map<string, ProposalEntry[]>()
    for (const p of activeProposals) {
      const list = map.get(p.message_id)
      if (list) list.push(p)
      else map.set(p.message_id, [p])
    }
    return map
  }, [activeProposals])
  const streamingProposals = proposalsByMessage.get('') ?? []
  const handleAcceptProposal = useCallback(
    async (proposalId: string) => {
      if (!effectiveConversationId) return
      const result = await acceptProposal(effectiveConversationId, proposalId)
      if (result.stale) {
        // Surface staleness inline via the card's status; nothing else to do.
      }
    },
    [effectiveConversationId, acceptProposal],
  )
  const handleRejectProposal = useCallback(
    (proposalId: string) => {
      if (!effectiveConversationId) return
      rejectProposal(effectiveConversationId, proposalId)
    },
    [effectiveConversationId, rejectProposal],
  )
  const handleSubmitLocalApproval = useCallback(
    (requestId: string, decision: 'accept' | 'reject') => {
      if (!effectiveConversationId) return
      void submitLocalApproval(effectiveConversationId, requestId, decision)
    },
    [effectiveConversationId, submitLocalApproval],
  )
  const handleStopMessage = useCallback(() => {
    if (!effectiveConversationId) return
    stopMessage(effectiveConversationId)
  }, [effectiveConversationId, stopMessage])
  const handleToggleProposalCollapsed = useCallback((proposalId: string) => {
    setCollapsedProposals((prev) => ({
      ...prev,
      [proposalId]: !prev[proposalId],
    }))
  }, [])
  // Fold every visible card the moment the user starts composing again. We
  // keep the cards on screen so the audit trail stays intact, but hide the
  // diff body so the conversation tail feels uncluttered.
  const handleComposerActivity = useCallback(() => {
    if (!effectiveConversationId) return
    const list = proposalsByConv[effectiveConversationId] ?? []
    if (list.length === 0) return
    setCollapsedProposals((prev) => {
      let changed = false
      const next = { ...prev }
      for (const p of list) {
        if (!next[p.proposal_id]) {
          next[p.proposal_id] = true
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [effectiveConversationId, proposalsByConv])
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

  if (availableWorkflows.length === 0) {
    return (
      <div className="tab-empty">
        当前没有启用的 Agent。去"团队管理" tab 启用一个 Agent。
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
              const nextAgentId = e.target.value || null
              if (documentId && nextAgentId) {
                onSelectAgentForDocument(documentId, nextAgentId)
              }
              setManualConversation(null)
            }}
          >
            {!validSelectedAgentId && (
              <option value="">加载 Agent…</option>
            )}
            {availableWorkflows.map((w) => (
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
                title={`对话历史 (${documentConversations.length})`}
              >
                <History size={14} />
                <span className="conversation-count">{documentConversations.length}</span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="conversation-dropdown" sideOffset={5}>
                <div className="conversation-dropdown-header">
                  <span>对话历史</span>
                </div>
                {documentConversations.length === 0 && (
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
                    items={documentConversations.map((c) => c.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {documentConversations.map((conv) => (
                      <SortableConversationItem
                        key={conv.id}
                        conv={conv}
                        agentName={
                          availableWorkflows.find((workflow) => workflow.id === conv.workflow_id)
                            ?.name
                        }
                        active={conv.id === effectiveConversationId}
                        renamingId={renamingId}
                        renameText={renameText}
                        onRenameTextChange={setRenameText}
                        onSelect={() => {
                          if (documentId) {
                            onSelectAgentForDocument(documentId, conv.workflow_id)
                          }
                          setManualConversation({
                            scopeKey: buildConversationScopeKey(conv.document_id, conv.workflow_id),
                            id: conv.id,
                          })
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
            disabled={!validSelectedAgentId}
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
              {!conversationsReadyForDocument
                ? '正在加载对话历史…'
                : documentConversations.length === 0
                ? '点击右上角 + 创建新对话'
                : '从右上角历史按钮选择一个对话'}
            </div>
          )}
          {effectiveConversationId && (
            <>
              <div className="message-stream" ref={messageStreamRef}>
                {activeMessages.map((msg) => {
                  const msgProposals = proposalsByMessage.get(msg.id)
                  return (
                    <Fragment key={msg.id}>
                      <MessageBubble
                        message={msg}
                        agentDisplayName={activeAgentName}
                        runStats={messageRunStats[msg.id]}
                        allCandidates={allCandidates}
                        onJumpToRange={onJumpToRange}
                      />
                      {msgProposals?.map((proposal) => (
                        <EditProposalCard
                          key={proposal.proposal_id}
                          proposal={proposal}
                          collapsed={collapsedProposals[proposal.proposal_id] ?? false}
                          onToggleCollapsed={() =>
                            handleToggleProposalCollapsed(proposal.proposal_id)
                          }
                          onAccept={() => handleAcceptProposal(proposal.proposal_id)}
                          onReject={() => handleRejectProposal(proposal.proposal_id)}
                          onJumpToRange={onJumpToRange}
                        />
                      ))}
                    </Fragment>
                  )
                })}
                {isStreaming && delta && (
                  <div className="message-bubble agent streaming">
                    <AgentRoleLine name={activeAgentName} runStats={activeStreamingStats} />
                    <AgentMarkdown source={delta} className="message-content" />
                  </div>
                )}
                {isStreaming && !delta && (
                  <div className="message-bubble agent streaming">
                    <AgentRoleLine name={activeAgentName} runStats={activeStreamingStats} />
                    <div className="message-content">
                      <Loader2 size={14} className="spin" /> {activeStreamingStats?.waitingReminder || '思考中…'}
                    </div>
                  </div>
                )}
                {streamingProposals.map((proposal) => (
                  <EditProposalCard
                    key={proposal.proposal_id}
                    proposal={proposal}
                    collapsed={collapsedProposals[proposal.proposal_id] ?? false}
                    onToggleCollapsed={() =>
                      handleToggleProposalCollapsed(proposal.proposal_id)
                    }
                    onAccept={() => handleAcceptProposal(proposal.proposal_id)}
                    onReject={() => handleRejectProposal(proposal.proposal_id)}
                    onJumpToRange={onJumpToRange}
                  />
                ))}
              </div>
              {activeLocalApprovals.length > 0 && (
                <LocalApprovalPanel
                  approvals={activeLocalApprovals}
                  onAccept={(id) => handleSubmitLocalApproval(id, 'accept')}
                  onReject={(id) => handleSubmitLocalApproval(id, 'reject')}
                />
              )}
              <DiscussionComposer
                allCandidates={allCandidates}
                agentCandidates={agentCandidates}
                workflowCandidates={workflowCandidates}
                fileCandidates={fileCandidates}
                activeSelection={activeSelection}
                isStreaming={isStreaming}
                onSend={handleSend}
                onStop={handleStopMessage}
                onJumpToRange={onJumpToRange}
                onUserActivity={handleComposerActivity}
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
  runStats?: AgentRunStats
  allCandidates: MentionCandidate[]
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
  onStop: () => void
  onJumpToRange?: (range: { from: number; to: number }) => void
  /**
   * Fired the first keystroke after the input has been empty / a send has
   * cleared it. Used to fold any open proposal cards once the user starts
   * composing the next message.
   */
  onUserActivity?: () => void
}

interface LocalApprovalPanelProps {
  approvals: LocalAgentApprovalEntry[]
  onAccept: (requestId: string) => void
  onReject: (requestId: string) => void
}

function LocalApprovalPanel({
  approvals,
  onAccept,
  onReject,
}: LocalApprovalPanelProps) {
  return (
    <div className="local-approval-panel" aria-live="polite">
      {approvals.map((approval) => {
        const decided = approval.status !== 'pending'
        return (
          <div key={approval.id} className={`local-approval-card status-${approval.status}`}>
            <div className="local-approval-main">
              <div className="local-approval-title-row">
                <span className="local-approval-title">{approval.title || 'Codex 请求确认'}</span>
                <span className="local-approval-method">{formatApprovalMethod(approval)}</span>
              </div>
              <div className="local-approval-summary">
                {approval.summary || approval.detail || 'Codex 正在等待你的确认。'}
              </div>
              {approval.error && (
                <div className="local-approval-error">{approval.error}</div>
              )}
            </div>
            <div className="local-approval-actions">
              {approval.status === 'pending' ? (
                <>
                  <button className="local-approval-accept" onClick={() => onAccept(approval.id)}>
                    <Check size={12} /> Accept
                  </button>
                  <button className="local-approval-reject" onClick={() => onReject(approval.id)}>
                    <X size={12} /> Reject
                  </button>
                </>
              ) : (
                <span className="local-approval-status">
                  {decided ? localApprovalStatusLabel(approval.status) : ''}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const DiscussionComposer = memo(function DiscussionComposer({
  allCandidates,
  agentCandidates,
  workflowCandidates,
  fileCandidates,
  activeSelection,
  isStreaming,
  onSend,
  onStop,
  onJumpToRange,
  onUserActivity,
}: DiscussionComposerProps) {
  const [inputText, setInputText] = useState('')
  const handleInputChange = useCallback(
    (next: string) => {
      setInputText((prev) => {
        if (prev.length === 0 && next.length > 0) {
          onUserActivity?.()
        }
        return next
      })
    },
    [onUserActivity],
  )

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
        onChange={handleInputChange}
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
        className={`primary-btn ${isStreaming ? 'stop-btn' : ''}`}
        onClick={isStreaming ? onStop : handleSubmit}
        disabled={!isStreaming && !inputText.trim()}
        title={isStreaming ? '停止当前 Agent' : '发送'}
      >
        {isStreaming ? <Square size={14} /> : <Send size={14} />}
      </button>
    </div>
  )
})

interface SortableConversationItemProps {
  conv: Conversation
  agentName?: string
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
  agentName,
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
              {agentName ? `${agentName} · ` : ''}{conv.message_count} 条 · {formatTime(conv.updated_at)}
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

function MessageBubble({
  message,
  agentDisplayName,
  runStats,
  allCandidates,
  onJumpToRange,
}: MessageBubbleProps) {
  const hasRange = message.range_start !== null && message.range_end !== null
  return (
    <div className={`message-bubble ${message.role}`}>
      {message.role === 'agent' ? (
        <>
          <AgentRoleLine name={agentDisplayName} runStats={runStats} />
          <AgentMarkdown source={message.content} className="message-content" />
        </>
      ) : message.role === 'user' ? (
        <UserMessageContent content={message.content} allCandidates={allCandidates} />
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

function AgentRoleLine({
  name,
  runStats,
}: {
  name: string
  runStats?: AgentRunStats
}) {
  const parts: string[] = []
  if (runStats?.filesRead) parts.push(`读文件 ${runStats.filesRead}`)
  if (runStats?.filesWritten) parts.push(`写文件 ${runStats.filesWritten}`)
  if (runStats?.stopped) parts.push('已停止')
  if (runStats?.waitingReminder) parts.push(runStats.waitingReminder)
  const bridgeLabel = formatBridgeStatus(runStats?.bridgeStatus)
  const localSession = formatShortSessionId(runStats?.localSessionId)
  const externalSession = formatShortSessionId(runStats?.externalSessionId)
  const runtimeLabel = formatSessionRuntime(runStats?.sessionRuntime)
  return (
    <div className="message-role">
      <span>{name}</span>
      {parts.length > 0 && <span className="agent-run-stats">{parts.join(' · ')}</span>}
      {localSession && (
        <span
          className="agent-session-status local"
          title={[
            `Local Host session: ${runStats?.localSessionId}`,
            runStats?.workspacePath ? `Workspace: ${runStats.workspacePath}` : '',
          ].filter(Boolean).join('\n')}
        >
          本机会话 {localSession}
        </span>
      )}
      {externalSession && (
        <span
          className="agent-session-status external"
          title={`${runtimeLabel} session: ${runStats?.externalSessionId}`}
        >
          {runtimeLabel} {externalSession}
        </span>
      )}
      {bridgeLabel && (
        <span
          className={`agent-bridge-status ${runStats?.bridgeStatus ?? ''}`}
          title={runStats?.bridgeError || bridgeLabel}
        >
          {bridgeLabel}
        </span>
      )}
    </div>
  )
}

function formatShortSessionId(value?: string): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.length <= 12) return raw
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`
}

function formatSessionRuntime(runtime?: AgentRunStats['sessionRuntime']): string {
  if (runtime === 'claude-local') return 'Claude 会话'
  if (runtime === 'codex-local') return 'Codex 会话'
  return 'Agent 会话'
}

function formatBridgeStatus(status?: AgentRunStats['bridgeStatus']): string {
  if (status === 'connected') return 'MCP 已连接'
  if (status === 'recovering') return 'MCP 重连中'
  if (status === 'error') return 'MCP 错误'
  return ''
}

function formatApprovalMethod(approval: LocalAgentApprovalEntry): string {
  if (approval.tool_name) return approval.tool_name
  if (approval.method.includes('elicitation')) return 'mcp'
  if (approval.method.includes('permissions')) return 'permissions'
  if (approval.method.includes('fileChange')) return 'file'
  if (approval.method.includes('commandExecution')) return 'command'
  return approval.method || 'approval'
}

function localApprovalStatusLabel(status: LocalAgentApprovalEntry['status']): string {
  if (status === 'accepted') return '已允许'
  if (status === 'rejected') return '已拒绝'
  if (status === 'error') return '提交失败'
  return '等待确认'
}

function UserMessageContent({
  content,
  allCandidates,
}: {
  content: string
  allCandidates: MentionCandidate[]
}) {
  const [expanded, setExpanded] = useState(false)
  const preview = useMemo(() => createUserMessagePreview(content), [content])
  const collapsible = preview !== content
  // Render with the same colored mention chips the input box uses, so the
  // bubble keeps the visual identity of what the user actually typed.
  const renderText = useCallback(
    (text: string) => {
      if (!text.includes('@')) return text
      const mentions = parseMentions(text, allCandidates)
      if (mentions.length === 0) return text
      const segments = segmentText(text, mentions)
      return segments.map((seg, i) => {
        if (seg.type === 'text') return <Fragment key={i}>{seg.content}</Fragment>
        const cls =
          seg.candidate.kind === 'file'
            ? 'mention-tag mention-tag-file'
            : seg.candidate.kind === 'workflow'
              ? 'mention-tag mention-tag-workflow'
              : 'mention-tag'
        return (
          <span key={i} className={cls}>
            {seg.raw}
          </span>
        )
      })
    },
    [allCandidates],
  )

  if (!collapsible) {
    return <div className="message-content">{renderText(content)}</div>
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
      {renderText(expanded ? content : preview)}
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

interface EditProposalCardProps {
  proposal: ProposalEntry
  collapsed: boolean
  onToggleCollapsed: () => void
  onAccept: () => void
  onReject: () => void
  onJumpToRange?: (range: { from: number; to: number }) => void
}

function EditProposalCard({
  proposal,
  collapsed,
  onToggleCollapsed,
  onAccept,
  onReject,
  onJumpToRange,
}: EditProposalCardProps) {
  const isPending = proposal.status === 'pending'
  const statusLabel = (() => {
    switch (proposal.status) {
      case 'accepted':
        return '已采纳'
      case 'rejected':
        return '已拒绝'
      case 'stale':
        return '原文已变化'
      default:
        return '待确认'
    }
  })()
  const summary =
    proposal.reason ||
    proposal.new_text.slice(0, 40) ||
    proposal.original_text.slice(0, 40) ||
    '空替换'
  const handleJump = () => {
    if (!onJumpToRange) return
    // Use the literal range from the proposal — RelativePosition resolution
    // happens at accept-time. Jumping is only a navigation hint, so an
    // off-by-a-few from concurrent edits is acceptable.
    onJumpToRange({ from: proposal.range_start, to: proposal.range_end })
  }
  return (
    <div
      className={`edit-proposal-card status-${proposal.status} ${
        collapsed ? 'is-collapsed' : 'is-expanded'
      }`}
    >
      <div className="edit-proposal-header">
        <button
          type="button"
          className="edit-proposal-toggle"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? '展开提案详情' : '折叠提案详情'}
        >
          <span className="edit-proposal-chevron">
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>
        <button
          type="button"
          className="edit-proposal-jump"
          onClick={handleJump}
          title="跳转到原文位置"
        >
          <FileEdit size={13} />
          <span className="edit-proposal-title">Agent 提议修改</span>
        </button>
        <span className={`edit-proposal-status ${proposal.status}`}>{statusLabel}</span>
      </div>
      {collapsed ? (
        <div className="edit-proposal-summary">{summary}</div>
      ) : (
        <>
          {proposal.reason && (
            <div className="edit-proposal-reason">{proposal.reason}</div>
          )}
          <div className="edit-proposal-diff">
            {proposal.original_text && (
              <div className="edit-proposal-diff-row removed">
                <span className="diff-marker">−</span>
                <span className="diff-text">{proposal.original_text}</span>
              </div>
            )}
            {proposal.new_text && (
              <div className="edit-proposal-diff-row added">
                <span className="diff-marker">+</span>
                <span className="diff-text">{proposal.new_text}</span>
              </div>
            )}
            {!proposal.original_text && !proposal.new_text && (
              <div className="edit-proposal-diff-empty">空替换</div>
            )}
          </div>
          {proposal.status === 'stale' && (
            <div className="edit-proposal-stale-hint">
              原文在你接受前已经变化，自动应用会覆盖你的改动。请人工核对后再处理。
            </div>
          )}
          {isPending && (
            <div className="edit-proposal-actions">
              <button className="edit-proposal-accept" onClick={onAccept}>
                <Check size={12} /> 接受
              </button>
              <button className="edit-proposal-reject" onClick={onReject}>
                <X size={12} /> 拒绝
              </button>
            </div>
          )}
        </>
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

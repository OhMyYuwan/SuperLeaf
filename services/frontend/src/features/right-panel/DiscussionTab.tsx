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

import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
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
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import './discussion.css'
import {
  MessageSquare,
  Plus,
  Loader2,
  History,
} from 'lucide-react'
import { useConversationStore } from '../../stores/conversationStore'
import type { ProposalEntry } from '../../stores/conversationStore'
import { useFilesystemStore } from '../../stores/filesystemStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { CachedWorkflow, Conversation } from '../../services/backendApi'
import type { Selection } from '../../types/editor'
import {
  parseMentions,
  flattenFileCandidates,
  sortFilesCurrentFirst,
  uniqueMentionedFiles,
  resolveAttachedFiles,
  type MentionCandidate,
} from '../../services/mentions'
import { confirmMultimodalBudget } from '../shared/fileSizeGate'
import { AgentMarkdown } from '../shared/AgentMarkdown'
import {
  conversationScopeKey as buildConversationScopeKey,
  documentConversationsNewestFirst,
  discussionComposerMentionCandidates,
  enabledDiscussionAgents,
  resolveDiscussionAgentId,
  timestampValue,
  type SelectedAgentByDocument,
} from './discussionAgentSelection'
import { formatAgentDisplayName } from './discussion/format'
import { AgentRoleLine } from './discussion/AgentRoleLine'
import { DiscussionComposer } from './discussion/DiscussionComposer'
import { EditProposalCard } from './discussion/EditProposalCard'
import { LocalApprovalPanel } from './discussion/LocalApprovalPanel'
import { MessageBubble } from './discussion/MessageBubble'
import { SortableConversationItem } from './discussion/SortableConversationItem'

interface DiscussionTabProps {
  workflows: CachedWorkflow[]
  documentId: string | null
  activeSelection: Selection | null
  selectedAgentByDocument: SelectedAgentByDocument
  onSelectAgentForDocument: (documentId: string, workflowId: string) => void
  onJumpToRange?: (range: { from: number; to: number }) => void
}

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
  const discussionMentionCandidates: MentionCandidate[] = useMemo(
    () =>
      discussionComposerMentionCandidates({
        agents: availableWorkflows,
        workflows: [],
        files: fileCandidates,
      }),
    [availableWorkflows, fileCandidates],
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

    const mentions = parseMentions(rawText, discussionMentionCandidates)
    // Keep the raw mention markers in the message body so the bubble can
    // render them with the same colored highlight the input box uses. The
    // backend gets attached_files via inputs separately, so the markers in
    // the text are purely a human-readable trace of what the user invoked.
    const mentionedFiles = uniqueMentionedFiles(mentions)

    // Check multimodal budget before resolving
    if (!confirmMultimodalBudget(mentionedFiles)) {
      return
    }

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
  }, [effectiveConversationId, discussionMentionCandidates, activeSelection, activeDocFormat, sendMessage])

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
                        allCandidates={discussionMentionCandidates}
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
                mentionCandidates={discussionMentionCandidates}
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

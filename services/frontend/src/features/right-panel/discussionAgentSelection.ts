import type { CachedWorkflow, Conversation } from '../../services/backendApi'

export type SelectedAgentByDocument = Record<string, string>

interface ResolveDiscussionAgentArgs {
  documentId: string | null
  workflows: CachedWorkflow[]
  conversations: Conversation[]
  selectedAgentByDocument: SelectedAgentByDocument
  activeProviderId?: string | null
}

export function enabledDiscussionAgents(workflows: CachedWorkflow[]): CachedWorkflow[] {
  return workflows.filter((workflow) => !workflow.is_disabled)
}

export function conversationScopeKey(documentId: string | null, workflowId: string | null): string {
  return `${documentId ?? ''}::${workflowId ?? ''}`
}

export function documentConversationsNewestFirst(
  conversations: Conversation[],
  documentId: string | null,
  enabledAgents: CachedWorkflow[],
): Conversation[] {
  if (!documentId) return []
  const enabledAgentIds = new Set(enabledAgents.map((agent) => agent.id))
  return conversations
    .filter((conversation) =>
      conversation.document_id === documentId &&
      enabledAgentIds.has(conversation.workflow_id),
    )
    .sort(compareConversationsNewestFirst)
}

export function resolveDiscussionAgentId({
  documentId,
  workflows,
  conversations,
  selectedAgentByDocument,
  activeProviderId,
}: ResolveDiscussionAgentArgs): string | null {
  const enabledAgents = enabledDiscussionAgents(workflows)
  if (enabledAgents.length === 0) return null

  const enabledAgentIds = new Set(enabledAgents.map((agent) => agent.id))
  const manualAgentId = documentId ? selectedAgentByDocument[documentId] : undefined
  if (manualAgentId && enabledAgentIds.has(manualAgentId)) return manualAgentId

  const recentConversation = documentConversationsNewestFirst(conversations, documentId, enabledAgents)[0]
  if (recentConversation) return recentConversation.workflow_id

  const defaultProviderAgent = activeProviderId
    ? enabledAgents.find((agent) => agent.provider_id === activeProviderId)
    : undefined
  return defaultProviderAgent?.id ?? enabledAgents[0]?.id ?? null
}

export function compareConversationsNewestFirst(a: Conversation, b: Conversation): number {
  if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
  const ka = a.sort_index ?? timestampValue(a.updated_at)
  const kb = b.sort_index ?? timestampValue(b.updated_at)
  return (
    kb - ka ||
    timestampValue(b.created_at) - timestampValue(a.created_at) ||
    b.id.localeCompare(a.id)
  )
}

export function timestampValue(iso: string): number {
  const value = new Date(iso).getTime()
  return Number.isFinite(value) ? value : 0
}

import { describe, expect, it } from 'vitest'
import type { CachedWorkflow, Conversation } from '../../services/backendApi'
import {
  conversationScopeKey,
  documentConversationsNewestFirst,
  enabledDiscussionAgents,
  resolveDiscussionAgentId,
} from './discussionAgentSelection'

describe('discussion Agent selection', () => {
  const workflows = [
    workflow({ id: 'wf-old', provider_id: 'provider-old', name: 'Old Agent' }),
    workflow({ id: 'wf-default', provider_id: 'provider-default', name: 'Default Agent' }),
    workflow({ id: 'wf-other', provider_id: 'provider-other', name: 'Other Agent' }),
    workflow({ id: 'wf-disabled', provider_id: 'provider-default', name: 'Disabled Agent', is_disabled: true }),
  ]

  it('starts a fresh document on the active Provider Agent', () => {
    expect(
      resolveDiscussionAgentId({
        documentId: 'doc-new',
        workflows,
        conversations: [],
        selectedAgentByDocument: {},
        activeProviderId: 'provider-default',
      }),
    ).toBe('wf-default')
  })

  it('restores the most recently discussed Agent for a document before using the default Provider', () => {
    const conversations = [
      conversation({ id: 'older', document_id: 'doc-1', workflow_id: 'wf-default', updated_at: '2026-06-08T10:00:00Z' }),
      conversation({ id: 'newer', document_id: 'doc-1', workflow_id: 'wf-other', updated_at: '2026-06-09T10:00:00Z' }),
    ]

    expect(
      resolveDiscussionAgentId({
        documentId: 'doc-1',
        workflows,
        conversations,
        selectedAgentByDocument: {},
        activeProviderId: 'provider-default',
      }),
    ).toBe('wf-other')
  })

  it('keeps a manual Agent choice scoped to the current document', () => {
    const conversations = [
      conversation({ id: 'newer', document_id: 'doc-1', workflow_id: 'wf-other', updated_at: '2026-06-09T10:00:00Z' }),
    ]

    expect(
      resolveDiscussionAgentId({
        documentId: 'doc-1',
        workflows,
        conversations,
        selectedAgentByDocument: { 'doc-1': 'wf-default', 'doc-2': 'wf-other' },
        activeProviderId: 'provider-default',
      }),
    ).toBe('wf-default')
  })

  it('lists history for every enabled Agent on the document in newest-first order', () => {
    const conversations = [
      conversation({ id: 'disabled', document_id: 'doc-1', workflow_id: 'wf-disabled', updated_at: '2026-06-10T10:00:00Z' }),
      conversation({ id: 'other-doc', document_id: 'doc-2', workflow_id: 'wf-other', updated_at: '2026-06-09T11:00:00Z' }),
      conversation({ id: 'older', document_id: 'doc-1', workflow_id: 'wf-default', updated_at: '2026-06-08T10:00:00Z' }),
      conversation({ id: 'newer', document_id: 'doc-1', workflow_id: 'wf-other', updated_at: '2026-06-09T10:00:00Z' }),
    ]

    expect(documentConversationsNewestFirst(conversations, 'doc-1', enabledDiscussionAgents(workflows)).map((c) => c.id))
      .toEqual(['newer', 'older'])
  })

  it('uses a stable document and Agent scope key for manual conversation focus', () => {
    expect(conversationScopeKey('doc-1', 'wf-other')).toBe('doc-1::wf-other')
  })
})

function workflow(patch: Partial<CachedWorkflow> & Pick<CachedWorkflow, 'id' | 'provider_id' | 'name'>): CachedWorkflow {
  return {
    external_id: patch.id,
    description: '',
    kind: 'agent',
    tags: [],
    last_synced_at: '2026-06-09T00:00:00Z',
    is_disabled: false,
    ...patch,
  }
}

function conversation(patch: Partial<Conversation> & Pick<Conversation, 'id' | 'document_id' | 'workflow_id'>): Conversation {
  return {
    title: '讨论',
    user_renamed: false,
    is_pinned: false,
    sort_index: null,
    external_conversation_id: '',
    created_at: patch.updated_at ?? '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    message_count: 1,
    last_message_preview: '',
    ...patch,
  }
}

import { beforeEach, describe, expect, it } from 'vitest'
import type { Conversation, CachedWorkflow } from '../services/backendApi'
import {
  resolveSuggestionAnnotationContext,
  useConversationStore,
} from './conversationStore'
import { useWorkflowStore } from './workflowStore'

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    document_id: 'doc-1',
    workflow_id: 'browser-codex:provider-1',
    title: 'Codex',
    user_renamed: false,
    is_pinned: false,
    sort_index: null,
    external_conversation_id: '',
    created_at: '2026-06-11T00:00:00.000Z',
    updated_at: '2026-06-11T00:00:00.000Z',
    message_count: 0,
    last_message_preview: '',
    ...overrides,
  }
}

function makeWorkflow(overrides: Partial<CachedWorkflow> = {}): CachedWorkflow {
  return {
    id: 'browser-codex:provider-1',
    provider_id: 'provider-1',
    external_id: 'provider-1',
    name: 'Local Codex',
    description: '',
    kind: 'codex-local',
    tags: [],
    last_synced_at: '2026-06-11T00:00:00.000Z',
    is_disabled: false,
    ...overrides,
  }
}

describe('conversation suggestion annotation context', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: { 'conv-1': makeConversation() },
      messages: {},
      loading: false,
      error: null,
      streaming: {},
      streamingDelta: {},
      streamingStats: {},
      messageRunStats: {},
      proposals: {},
      localApprovals: {},
    })
    useWorkflowStore.setState({
      workflows: [makeWorkflow()],
      loading: false,
      loaded: true,
      error: null,
    })
  })

  it('uses the conversation workflow id instead of the conversation id', () => {
    const result = resolveSuggestionAnnotationContext('conv-1')

    expect(result.sourceConversationId).toBe('conv-1')
    expect(result.workflowId).toBe('browser-codex:provider-1')
    expect(result.agentName).toBe('Local Codex')
  })

  it('lets an explicit side-event workflow id override the conversation mapping', () => {
    const result = resolveSuggestionAnnotationContext('conv-1', {
      workflow_id: 'browser-claude:provider-2',
      agent_name: 'Local Claude',
    })

    expect(result.workflowId).toBe('browser-claude:provider-2')
    expect(result.agentName).toBe('Local Claude')
  })
})

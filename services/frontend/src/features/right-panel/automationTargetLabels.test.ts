import { describe, expect, it } from 'vitest'
import type { CachedWorkflow, NativeAgent, WorkflowDefinition } from '../../services/backendApi'
import {
  formatAutomationTargetName,
  formatNativeAgentDisplayName,
} from './automationTargetLabels'

describe('automation Agent target labels', () => {
  it('shows workflow Agent targets as Agent name followed by provider name', () => {
    const label = formatAutomationTargetName(
      'agent',
      workflow({
        id: 'agent-writer',
        provider_id: 'provider-dify',
        name: 'Writer Bot',
      }),
      new Map([['provider-dify', 'Dify Lab']]),
    )

    expect(label).toBe('Writer Bot (Dify Lab)')
  })

  it('keeps Workflow targets as workflow names', () => {
    const label = formatAutomationTargetName(
      'workflow',
      workflowDefinition({ id: 'wf-draft', name: 'Draft Workflow' }),
      new Map([['provider-dify', 'Dify Lab']]),
    )

    expect(label).toBe('Draft Workflow')
  })

  it('shows native Agent targets as Agent name followed by settings provider name', () => {
    const label = formatNativeAgentDisplayName(
      nativeAgent({
        id: 'native-replier',
        provider_id: 'provider-native',
        name: 'Reply Bot',
      }),
      new Map([['provider-native', 'Codex Local']]),
    )

    expect(label).toBe('Reply Bot (Codex Local)')
  })
})

function workflow(patch: Partial<CachedWorkflow> & Pick<CachedWorkflow, 'id' | 'provider_id' | 'name'>): CachedWorkflow {
  return {
    external_id: patch.id,
    description: '',
    kind: 'agent',
    tags: [],
    last_synced_at: '2026-06-13T00:00:00Z',
    is_disabled: false,
    ...patch,
  }
}

function workflowDefinition(patch: Partial<WorkflowDefinition> & Pick<WorkflowDefinition, 'id' | 'name'>): WorkflowDefinition {
  return {
    description: '',
    execution_mode: 'graph',
    graph: { nodes: [], edges: [] },
    config: {},
    version: 1,
    is_active: true,
    created_at: '2026-06-13T00:00:00Z',
    updated_at: '2026-06-13T00:00:00Z',
    ...patch,
  }
}

function nativeAgent(patch: Partial<NativeAgent> & Pick<NativeAgent, 'id' | 'provider_id' | 'name'>): NativeAgent {
  return {
    project_id: 'project-1',
    owner_user_id: 'user-1',
    description: '',
    model: 'gpt-5',
    instructions: '',
    agent_md: '',
    skill_ids: [],
    workspace_path: '',
    setup_status: 'ready',
    setup_log: '',
    output_contract: 'freeform',
    runtime_config: {},
    is_enabled: true,
    created_at: '2026-06-13T00:00:00Z',
    updated_at: '2026-06-13T00:00:00Z',
    ...patch,
  }
}

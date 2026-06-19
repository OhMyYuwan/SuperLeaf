import { describe, expect, it } from 'vitest'
import type { CachedWorkflow } from '../../../services/backendApi'
import { formatWorkflowAgentOption } from './agentOptionFormat'
import { pruneInlineProviderConfig } from './NodeInspector'

describe('Workflow NodeInspector Agent option labels', () => {
  it('shows Agent options as Agent name followed by provider name', () => {
    const label = formatWorkflowAgentOption(
      workflow({
        id: 'agent-review',
        provider_id: 'provider-dify',
        name: 'Review Bot',
      }),
      new Map([['provider-dify', 'Dify Lab']]),
    )

    expect(label).toBe('Review Bot (Dify Lab)')
  })

  it('uses the same base label for disabled Agent options', () => {
    const label = `${formatWorkflowAgentOption(
      workflow({
        id: 'agent-disabled',
        provider_id: 'provider-nanobot',
        name: 'Disabled Bot',
        is_disabled: true,
      }),
      new Map([['provider-nanobot', 'Nanobot Local']]),
    )}（已禁用）`

    expect(label).toBe('Disabled Bot (Nanobot Local)（已禁用）')
  })
})

describe('Workflow inline Agent provider config', () => {
  it('keeps provider and model but drops runtime knobs from new node config', () => {
    expect(
      pruneInlineProviderConfig({
        provider_id: 'provider-native',
        model: 'gpt-5',
        temperature: 0.8,
        max_tokens: 4096,
      }),
    ).toEqual({
      provider_id: 'provider-native',
      model: 'gpt-5',
    })
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

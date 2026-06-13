import { describe, expect, it } from 'vitest'
import type { CachedWorkflow } from '../../services/backendApi'
import { formatAutomationTargetName } from './AnnotationAutomationPanel'

describe('AnnotationAutomationPanel Agent picker', () => {
  it('shows Agent options as Agent name followed by provider name', () => {
    const label = formatAutomationTargetName(
      'agent',
      workflow({
        id: 'agent-review',
        provider_id: 'provider-dify',
        name: 'Review Bot',
      }),
      new Map([['provider-dify', 'Dify Lab']]),
    )

    expect(label).toBe('Review Bot (Dify Lab)')
  })

  it('keeps Workflow options as workflow names', () => {
    const label = formatAutomationTargetName(
      'workflow',
      workflow({
        id: 'workflow-review',
        provider_id: 'provider-dify',
        name: 'Review Workflow',
      }),
      new Map([['provider-dify', 'Dify Lab']]),
    )

    expect(label).toBe('Review Workflow')
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

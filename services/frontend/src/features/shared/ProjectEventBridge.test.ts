import { describe, expect, it } from 'vitest'
import type { AnnotationItem } from '../../stores/annotationStore'
import { isRangeOnlyAnnotationUpdate } from './ProjectEventBridge'

function makeAnnotation(overrides: Partial<AnnotationItem> = {}): AnnotationItem {
  return {
    id: 'ann-1',
    documentId: 'doc-1',
    userId: 'user-1',
    isGlobal: false,
    workflowId: 'agent-1',
    agentName: 'Agent',
    kind: 'annotation',
    status: 'pending',
    range: { from: 10, to: 20 },
    targetText: 'annotated text',
    content: 'Check this.',
    severity: 'medium',
    thread: [],
    createdAt: new Date('2026-06-11T00:00:00.000Z'),
    ...overrides,
  }
}

describe('ProjectEventBridge annotation event helpers', () => {
  it('detects range-only annotation updates', () => {
    const current = makeAnnotation()
    const incoming = makeAnnotation({ range: { from: 13, to: 23 } })

    expect(isRangeOnlyAnnotationUpdate(current, incoming)).toBe(true)
  })

  it('does not treat content changes as range-only updates', () => {
    const current = makeAnnotation()
    const incoming = makeAnnotation({
      range: { from: 13, to: 23 },
      content: 'Updated note.',
    })

    expect(isRangeOnlyAnnotationUpdate(current, incoming)).toBe(false)
  })
})

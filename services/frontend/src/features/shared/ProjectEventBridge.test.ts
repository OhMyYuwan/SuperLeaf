import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationItem } from '../../stores/annotationStore'
import { useAnnotationStore } from '../../stores/annotationStore'
import type { AnnotationDto } from '../../services/annotationEvaluationApi'
import type { ProjectEvent } from '../../services/projectEventStream'
import { dispatchProjectEvent, isRangeOnlyAnnotationUpdate } from './ProjectEventBridge'

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

describe('ProjectEventBridge annotation privacy events', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, String(value))),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    })
    useAnnotationStore.setState({
      items: {},
      byRun: {},
      reviewStatusByAnnotation: {},
      evaluationsByAnnotation: {},
    } as Partial<ReturnType<typeof useAnnotationStore.getState>>)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not add private annotation events that belong to another user', () => {
    dispatchProjectEvent(makeAnnotationEvent('annotation.created', {
      id: 'ann-private-other',
      user_id: 'user-other',
      is_global: false,
    }), 'user-current')

    expect(useAnnotationStore.getState().items['ann-private-other']).toBeUndefined()
  })

  it('removes a local annotation when an update makes it private to another user', () => {
    useAnnotationStore.getState().applyRemoteAnnotationUpsert(makeAnnotation({
      id: 'ann-private-other',
      userId: 'user-other',
      isGlobal: true,
    }))

    dispatchProjectEvent(makeAnnotationEvent('annotation.updated', {
      id: 'ann-private-other',
      user_id: 'user-other',
      is_global: false,
    }), 'user-current')

    expect(useAnnotationStore.getState().items['ann-private-other']).toBeUndefined()
  })
})

function makeAnnotationDto(overrides: Partial<AnnotationDto> = {}): AnnotationDto {
  return {
    id: 'ann-1',
    doc_id: 'doc-1',
    project_id: 'project-1',
    user_id: 'user-1',
    is_global: false,
    workflow_id: 'agent-1',
    agent_name: 'Agent',
    kind: 'annotation',
    status: 'pending',
    range_from: 10,
    range_to: 20,
    target_text: 'annotated text',
    content: 'Check this.',
    severity: 'medium',
    conversation_id: '',
    original: '',
    proposed: '',
    reason: '',
    risk_type: '',
    mitigation: '',
    thread: [],
    attached_files: [],
    created_at: '2026-06-11T00:00:00.000Z',
    updated_at: '2026-06-11T00:00:00.000Z',
    archived_at: null,
    ...overrides,
  }
}

function makeAnnotationEvent(
  type: 'annotation.created' | 'annotation.updated',
  annotationOverrides: Partial<AnnotationDto>,
): ProjectEvent {
  return {
    id: `evt-${annotationOverrides.id ?? 'ann-1'}`,
    seq: 1,
    type,
    ts: '2026-06-11T00:00:00.000Z',
    project_id: 'project-1',
    origin_client_id: 'client-other',
    payload: {
      annotation: makeAnnotationDto(annotationOverrides),
    },
  }
}

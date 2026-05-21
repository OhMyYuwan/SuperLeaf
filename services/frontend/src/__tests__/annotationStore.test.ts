import { beforeEach, describe, expect, it, vi } from 'vitest'
import { annotationEvaluationApi } from '../services/annotationEvaluationApi'
import { type AnnotationItem, useAnnotationStore } from '../stores/annotationStore'

vi.mock('../services/annotationEvaluationApi', () => ({
  annotationEvaluationApi: {
    patchAnnotation: vi.fn(() => Promise.resolve({})),
  },
}))

vi.mock('../stores/_userScopedStorage', () => ({
  createUserScopedStorage: () => ({
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  }),
}))

function makeItem(overrides: Partial<AnnotationItem> = {}): AnnotationItem {
  return {
    id: 'ann-1',
    documentId: 'doc-1',
    userId: 'user-1',
    isGlobal: false,
    workflowId: '',
    agentName: '',
    kind: 'user-comment',
    status: 'pending',
    range: { from: 10, to: 20 },
    targetText: 'deleted text',
    content: 'keep this card',
    severity: 'medium',
    thread: [],
    createdAt: new Date('2026-05-21T00:00:00Z'),
    ...overrides,
  }
}

describe('annotationStore.applyDocumentChange', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAnnotationStore.setState({
      items: {},
      byRun: {},
      reviewStatusByAnnotation: {},
      evaluationsByAnnotation: {},
    })
  })

  it('keeps fully deleted annotations pending and persists a collapsed range', () => {
    useAnnotationStore.setState({
      items: { 'ann-1': makeItem() },
    })

    useAnnotationStore.getState().applyDocumentChange('doc-1', [
      { from: 10, to: 20, insertLen: 0 },
    ])

    expect(useAnnotationStore.getState().items['ann-1']).toMatchObject({
      status: 'pending',
      range: { from: 10, to: 10 },
      targetText: 'deleted text',
    })
    expect(annotationEvaluationApi.patchAnnotation).toHaveBeenCalledWith('ann-1', {
      range_from: 10,
      range_to: 10,
    })
    expect(annotationEvaluationApi.patchAnnotation).not.toHaveBeenCalledWith(
      'ann-1',
      expect.objectContaining({ status: 'superseded' }),
    )
  })

  it('persists replacement ranges without changing status', () => {
    useAnnotationStore.setState({
      items: { 'ann-1': makeItem() },
    })

    useAnnotationStore.getState().applyDocumentChange('doc-1', [
      { from: 10, to: 20, insertLen: 5 },
    ])

    expect(useAnnotationStore.getState().items['ann-1']).toMatchObject({
      status: 'pending',
      range: { from: 10, to: 15 },
    })
    expect(annotationEvaluationApi.patchAnnotation).toHaveBeenCalledWith('ann-1', {
      range_from: 10,
      range_to: 15,
    })
  })

  it('does not patch pure before-range offset changes', () => {
    useAnnotationStore.setState({
      items: { 'ann-1': makeItem() },
    })

    useAnnotationStore.getState().applyDocumentChange('doc-1', [
      { from: 0, to: 0, insertLen: 3 },
    ])

    expect(useAnnotationStore.getState().items['ann-1'].range).toEqual({ from: 13, to: 23 })
    expect(annotationEvaluationApi.patchAnnotation).not.toHaveBeenCalled()
  })
})

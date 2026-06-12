import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { annotationEvaluationApi } from '../services/annotationEvaluationApi'
import { useAnnotationStore, type AnnotationItem } from './annotationStore'

vi.mock('../services/annotationEvaluationApi', () => ({
  annotationEvaluationApi: {
    patchAnnotation: vi.fn(),
    createAnnotation: vi.fn(),
    removeAnnotation: vi.fn(),
    listByDoc: vi.fn(),
    listReviewStatesByDoc: vi.fn(),
    listAnnotationsByDoc: vi.fn(),
  },
}))

vi.mock('../features/shared/toast', () => ({
  showToast: vi.fn(),
}))

const patchAnnotation = vi.mocked(annotationEvaluationApi.patchAnnotation)

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

describe('annotationStore.applyDocumentChange', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
      clear: () => { storage.clear() },
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() { return storage.size },
    })
    vi.clearAllMocks()
    patchAnnotation.mockResolvedValue({} as Awaited<ReturnType<typeof annotationEvaluationApi.patchAnnotation>>)
    useAnnotationStore.setState({
      items: { 'ann-1': makeAnnotation() },
      byRun: {},
      reviewStatusByAnnotation: {},
      evaluationsByAnnotation: {},
    })
  })

  it('persists range shifts caused by edits before an annotation', () => {
    useAnnotationStore.getState().applyDocumentChange('doc-1', [
      { from: 0, to: 0, insertLen: 3 },
    ])

    expect(useAnnotationStore.getState().items['ann-1'].range).toEqual({ from: 13, to: 23 })
    expect(patchAnnotation).toHaveBeenCalledWith('ann-1', {
      range_from: 13,
      range_to: 23,
    })
  })

  it('does not persist when the range is unchanged', () => {
    useAnnotationStore.getState().applyDocumentChange('doc-1', [
      { from: 30, to: 30, insertLen: 3 },
    ])

    expect(useAnnotationStore.getState().items['ann-1'].range).toEqual({ from: 10, to: 20 })
    expect(patchAnnotation).not.toHaveBeenCalled()
  })

  it('recovers a drifted annotation range and persists the repaired range', () => {
    useAnnotationStore.setState({
      items: {
        'ann-1': makeAnnotation({
          range: { from: 0, to: 6 },
          targetText: 'annotated text',
        }),
      },
      byRun: {},
      reviewStatusByAnnotation: {},
      evaluationsByAnnotation: {},
    })

    const summary = useAnnotationStore.getState().recoverRangesForDocument(
      'doc-1',
      'prefix annotated text suffix',
    )

    expect(summary.recovered).toBe(1)
    expect(summary.needsReview).toBe(0)
    expect(useAnnotationStore.getState().items['ann-1'].range).toEqual({ from: 7, to: 21 })
    expect(patchAnnotation).toHaveBeenCalledWith('ann-1', {
      range_from: 7,
      range_to: 21,
    })
  })
})

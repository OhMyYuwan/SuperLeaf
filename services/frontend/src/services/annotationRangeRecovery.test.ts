import { describe, expect, it } from 'vitest'
import { recoverAnnotationRange } from './annotationRangeRecovery'

function annotation(overrides: {
  range?: { from: number; to: number }
  targetText?: string
  original?: string
} = {}) {
  return {
    id: 'ann-1',
    kind: 'annotation',
    range: overrides.range ?? { from: 4, to: 18 },
    targetText: overrides.targetText ?? 'annotated text',
    original: overrides.original,
  }
}

describe('recoverAnnotationRange', () => {
  it('marks an annotation stable when the current range still matches', () => {
    const result = recoverAnnotationRange(
      annotation({ range: { from: 4, to: 18 } }),
      'xxxxannotated textyyyy',
    )

    expect(result.status).toBe('stable')
    expect(result.range).toEqual({ from: 4, to: 18 })
    expect(result.confidence).toBe(1)
  })

  it('recovers a unique exact match when the stored range drifted', () => {
    const result = recoverAnnotationRange(
      annotation({ range: { from: 0, to: 14 } }),
      'prefix annotated text suffix',
    )

    expect(result.status).toBe('recovered')
    expect(result.range).toEqual({ from: 7, to: 21 })
    expect(result.confidence).toBeGreaterThanOrEqual(0.95)
  })

  it('does not recover repeated exact matches without a clear nearest candidate', () => {
    const result = recoverAnnotationRange(
      annotation({ range: { from: 12, to: 26 } }),
      'annotated text xx annotated text',
    )

    expect(result.status).toBe('needs_review')
    expect(result.candidates.length).toBe(2)
  })

  it('recovers a high-confidence fuzzy match near the old range', () => {
    const result = recoverAnnotationRange(
      annotation({
        range: { from: 6, to: 35 },
        targetText: 'structural fidelity improves',
      }),
      'intro structural accuracy improves outro',
    )

    expect(result.status).toBe('recovered')
    expect(result.range.from).toBe(6)
    expect(result.confidence).toBeGreaterThanOrEqual(0.82)
  })
})

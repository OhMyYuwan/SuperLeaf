import { describe, expect, it } from 'vitest'

import { projectDiffToText } from '../features/history/highlights-from-diff'

describe('projectDiffToText', () => {
  it('projects diff chunks and highlights without changing the rendered order', () => {
    const projected = projectDiffToText([
      { u: 'alpha\n' },
      { d: 'old\n', meta: { start_ts: 1 } },
      { i: 'new\n', meta: { start_ts: 2 } },
      { u: 'omega\n' },
    ])

    expect(projected.text).toBe('alpha\nold\nnew\nomega\n')
    expect(projected.highlights).toEqual([
      { from: 6, to: 10, kind: 'deletion', startTs: 1 },
      { from: 10, to: 14, kind: 'insertion', startTs: 2 },
    ])
  })
})

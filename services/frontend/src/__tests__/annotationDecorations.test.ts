import { describe, expect, it } from 'vitest'
import { __test__ } from '../features/latex-editor/annotation-decorations'

describe('annotation decorations', () => {
  it('does not render collapsed annotation anchors into the editor text flow', () => {
    const decorations = __test__.buildDecorations({
      activeId: null,
      flashId: null,
      specs: [
        {
          id: 'ann-1',
          from: 12,
          to: 12,
          kind: 'user-comment',
          severity: 'medium',
        },
      ],
    })
    const ranges: Array<{ from: number; to: number }> = []

    decorations.between(0, 20, (from, to) => {
      ranges.push({ from, to })
    })

    expect(ranges).toEqual([])
  })
})

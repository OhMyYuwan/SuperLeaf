import { describe, expect, it } from 'vitest'
import {
  collectLatexCitationCompletions,
  extractBibEntries,
  extractBibitemKeys,
  filterCitationCompletions,
  findCitationArgumentContext,
  scoreCitationCompletion,
} from '../features/latex-editor/latex-completion-data'

const bib = `
@article{vaswani2017attention,
  title={Attention Is All You Need},
  author={Vaswani, Ashish and Shazeer, Noam},
  year={2017}
}

@inproceedings{dosovitskiy2021image,
  title={An Image is Worth 16x16 Words},
  author={Dosovitskiy, Alexey},
  year={2021}
}
`

describe('latex completion data', () => {
  it('extracts BibTeX citation keys with useful metadata', () => {
    const entries = collectLatexCitationCompletions([
      { name: 'references.bib', content: bib },
    ])

    expect(entries.map((entry) => entry.key)).toEqual([
      'dosovitskiy2021image',
      'vaswani2017attention',
    ])
    expect(entries.find((entry) => entry.key === 'vaswani2017attention')?.detail).toContain('2017')
    expect(extractBibEntries(bib, 'references.bib')[0].title).toBe('Attention Is All You Need')
  })

  it('extracts bibitem keys', () => {
    expect(extractBibitemKeys('\\bibitem{knuth1984} The TeXbook')).toEqual(['knuth1984'])
  })

  it('finds the current cite argument segment', () => {
    const context = findCitationArgumentContext('See \\citep{vaswani2017attention, dos')

    expect(context).toEqual({
      fromOffset: 'See \\citep{vaswani2017attention, '.length,
      query: 'dos',
      existingKeys: ['vaswani2017attention'],
    })
  })

  it('filters citations with prefix matches before contains matches', () => {
    const filtered = filterCitationCompletions(
      [
        { key: 'alpha-control' },
        { key: 'vaswani2017attention' },
        { key: 'control-alpha' },
      ],
      'al',
    )

    expect(filtered.map((entry) => entry.key)).toEqual(['alpha-control', 'control-alpha'])
  })

  it('filters citations against key, title, author, and multi-token input', () => {
    const entries = collectLatexCitationCompletions([
      { name: 'references.bib', content: bib },
    ])

    expect(filterCitationCompletions(entries, 'worth words')[0].key).toBe('dosovitskiy2021image')
    expect(filterCitationCompletions(entries, 'shazeer')[0].key).toBe('vaswani2017attention')
    expect(filterCitationCompletions(entries, '2017')[0].key).toBe('vaswani2017attention')
    expect(filterCitationCompletions(entries, 'vas', ['vaswani2017attention']).map((entry) => entry.key))
      .not.toContain('vaswani2017attention')
  })

  it('weights citation key matches above bibliography metadata matches', () => {
    const keyMatch = { key: 'attention2024', title: 'A Different Paper' }
    const titleMatch = { key: 'paper2024', title: 'Attention Methods' }

    expect(scoreCitationCompletion(keyMatch, 'attention')).toBeGreaterThan(
      scoreCitationCompletion(titleMatch, 'attention'),
    )
  })
})

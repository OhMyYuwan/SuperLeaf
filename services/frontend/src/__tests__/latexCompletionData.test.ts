import { describe, expect, it } from 'vitest'
import {
  collectLatexCitationCompletions,
  collectLatexCitationKeyUsages,
  collectLatexCommandCompletions,
  collectLatexReferenceKeyUsages,
  extractBibEntries,
  extractBibitemKeys,
  extractLatexCommandDefinitions,
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

  it('collects citation key ranges from cite commands', () => {
    const content = 'See \\citep[chap. 2]{vaswani2017attention, missing2024} and \\nocite{*}.'

    expect(collectLatexCitationKeyUsages(content)).toEqual([
      {
        key: 'vaswani2017attention',
        from: content.indexOf('vaswani2017attention'),
        to: content.indexOf('vaswani2017attention') + 'vaswani2017attention'.length,
        command: 'citep',
      },
      {
        key: 'missing2024',
        from: content.indexOf('missing2024'),
        to: content.indexOf('missing2024') + 'missing2024'.length,
        command: 'citep',
      },
    ])
  })

  it('collects reference key ranges from ref commands', () => {
    const content = 'See \\ref{sec:intro}, \\eqref{eq:loss}, and \\cref{fig:a, tab:b}.'

    expect(collectLatexReferenceKeyUsages(content)).toEqual([
      {
        key: 'sec:intro',
        from: content.indexOf('sec:intro'),
        to: content.indexOf('sec:intro') + 'sec:intro'.length,
        command: 'ref',
      },
      {
        key: 'eq:loss',
        from: content.indexOf('eq:loss'),
        to: content.indexOf('eq:loss') + 'eq:loss'.length,
        command: 'eqref',
      },
      {
        key: 'fig:a',
        from: content.indexOf('fig:a'),
        to: content.indexOf('fig:a') + 'fig:a'.length,
        command: 'cref',
      },
      {
        key: 'tab:b',
        from: content.indexOf('tab:b'),
        to: content.indexOf('tab:b') + 'tab:b'.length,
        command: 'cref',
      },
    ])
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

  it('extracts custom command definitions for autocomplete', () => {
    const content = [
      '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
      '\\newcommand*\\todo[2][note]{\\textbf{#1}: #2}',
      '\\renewcommand{\\oldmacro}{Updated}',
      '\\providecommand{\\fallback}[3]{#1#2#3}',
      '\\DeclareRobustCommand{\\safe}[1]{#1}',
      '\\def\\quick#1#2{#1 #2}',
    ].join('\n')

    expect(extractLatexCommandDefinitions(content, 'main.tex')).toEqual([
      { name: 'vect', source: 'main.tex', optionalArgCount: 0, requiredArgCount: 1 },
      { name: 'todo', source: 'main.tex', optionalArgCount: 1, requiredArgCount: 1 },
      { name: 'oldmacro', source: 'main.tex', optionalArgCount: 0, requiredArgCount: 0 },
      { name: 'fallback', source: 'main.tex', optionalArgCount: 0, requiredArgCount: 3 },
      { name: 'safe', source: 'main.tex', optionalArgCount: 0, requiredArgCount: 1 },
      { name: 'quick', source: 'main.tex', requiredArgCount: 2 },
    ])
  })

  it('deduplicates custom commands across project documents', () => {
    const commands = collectLatexCommandCompletions([
      { name: 'main.tex', content: '\\newcommand{\\term}[1]{#1}' },
      { name: 'defs.tex', content: '\\newcommand{\\term}[2]{#1 #2}' },
    ])

    expect(commands).toEqual([
      { name: 'term', source: 'main.tex', optionalArgCount: 0, requiredArgCount: 2 },
    ])
  })
})

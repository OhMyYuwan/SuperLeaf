import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  latex,
  latexCompletionSource,
  missingCitationDiagnosticsForContent,
  missingReferenceDiagnosticsForContent,
  positionLatexCompletionInfo,
} from '../features/latex-editor/latex-language'
import type { LatexCompletionData } from '../features/latex-editor/latex-completion-data'

describe('latex language completion source', () => {
  it('recomputes command candidates as the user types after backslash', () => {
    const slash = complete('\\')
    expect(labelsOf(slash).length).toBeGreaterThan(20)

    const c = updateCompletion(slash, '\\c')
    const cLabels = labelsOf(c)
    expect(cLabels.length).toBeLessThan(labelsOf(slash).length)
    expect(cLabels[0]).toBe('\\cite')
    expect(cLabels.slice(0, 5).some((label) => label.startsWith('\\c'))).toBe(true)

    const ci = updateCompletion(c, '\\ci')
    const ciLabels = labelsOf(ci)
    expect(ciLabels.length).toBeLessThan(cLabels.length)
    expect(ciLabels[0]).toBe('\\cite')
    expect(ciLabels.slice(0, 5).every((label) => label.toLowerCase().includes('ci'))).toBe(true)
    expect(ciLabels).not.toContain('\\section')
  })

  it('filters citation candidates in real time from the current cite fragment', () => {
    const completionData: LatexCompletionData = {
      citations: [
        {
          key: 'vaswani2017attention',
          title: 'Attention Is All You Need',
          author: 'Vaswani, Ashish and Shazeer, Noam',
          year: '2017',
        },
        {
          key: 'dosovitskiy2021image',
          title: 'An Image is Worth 16x16 Words',
          author: 'Dosovitskiy, Alexey',
          year: '2021',
        },
      ],
      filePaths: [],
      labels: [],
      commands: [],
    }

    const empty = complete('\\cite{', completionData)
    expect(labelsOf(empty)).toEqual(['dosovitskiy2021image', 'vaswani2017attention'])

    const dos = updateCompletion(empty, '\\cite{dos', completionData)
    expect(labelsOf(dos)).toEqual(['dosovitskiy2021image'])

    const titleMatch = complete('\\cite{worth words', completionData)
    expect(labelsOf(titleMatch)).toEqual(['dosovitskiy2021image'])
  })

  it('keeps citation rows compact and moves citation info above the list', () => {
    const result = complete('\\cite{vas', {
      citations: [
        {
          key: 'vaswani2017attention',
          title: 'Attention Is All You Need',
          author: 'Vaswani, Ashish and Shazeer, Noam',
          year: '2017',
          detail: 'Vaswani et al. · 2017',
          info: 'Attention Is All You Need\nVaswani et al. · 2017',
        },
      ],
      filePaths: [],
      labels: [],
      commands: [],
    })
    const option = result.options[0]

    expect(option.label).toBe('vaswani2017attention')
    expect(option.detail).toBeUndefined()
    expect(option.info).toContain('Attention Is All You Need')

    const placement = positionLatexCompletionInfo(
      {} as Parameters<typeof positionLatexCompletionInfo>[0],
      { left: 400, right: 680, top: 180, bottom: 420 },
      { left: 400, right: 680, top: 200, bottom: 224 },
      { left: 0, right: 520, top: 0, bottom: 100 },
      { left: 0, right: 700, top: 0, bottom: 600 },
    )
    expect(placement.class).toBe('cm-completionInfo-above')
    expect(placement.style).toContain('bottom: calc(100% + 8px)')
    expect(placement.style).toContain('width:')
  })

  it('marks unresolved citation keys with a citation warning', () => {
    const content = 'Known \\cite{vaswani2017attention, missing2024}.'
    const diagnostics = missingCitationDiagnosticsForContent(content, [
      { key: 'vaswani2017attention' },
    ])

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      from: content.indexOf('missing2024'),
      to: content.indexOf('missing2024') + 'missing2024'.length,
      severity: 'warning',
      source: 'citation',
      markClass: 'ylw-cm-missing-citation',
      message: '未找到引用: "missing2024"',
    })
  })

  it('does not mark citations before bibliography keys are loaded', () => {
    expect(missingCitationDiagnosticsForContent('\\cite{missing2024}', [])).toEqual([])
  })

  it('marks unresolved reference keys with a reference warning', () => {
    const content = 'Known \\ref{sec:intro}; missing \\eqref{eq:missing}.'
    const diagnostics = missingReferenceDiagnosticsForContent(content, [
      { key: 'sec:intro' },
    ])

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      from: content.indexOf('eq:missing'),
      to: content.indexOf('eq:missing') + 'eq:missing'.length,
      severity: 'warning',
      source: 'reference',
      markClass: 'ylw-cm-missing-reference',
      message: '未找到标签: "eq:missing"',
    })
  })

  it('does not mark references before labels are loaded', () => {
    expect(missingReferenceDiagnosticsForContent('\\ref{sec:missing}', [])).toEqual([])
  })

  it('completes custom commands collected from newcommand definitions', () => {
    const slash = complete('\\', {
      citations: [],
      filePaths: [],
      labels: [],
      commands: [
        { name: 'vect', source: 'main.tex', requiredArgCount: 1 },
        { name: 'todo', source: 'macros.tex', optionalArgCount: 1, requiredArgCount: 1 },
      ],
    })

    const labels = labelsOf(slash)
    expect(labels).toContain('\\vect{}')
    expect(labels).toContain('\\todo[]{}')

    const ve = updateCompletion(slash, '\\ve', {
      citations: [],
      filePaths: [],
      labels: [],
      commands: [
        { name: 'vect', source: 'main.tex', requiredArgCount: 1 },
        { name: 'todo', source: 'macros.tex', optionalArgCount: 1, requiredArgCount: 1 },
      ],
    })
    expect(labelsOf(ve)).toContain('\\vect{}')
    expect(labelsOf(ve)).not.toContain('\\todo[]{}')
  })
})

function complete(
  doc: string,
  completionData?: LatexCompletionData,
): CompletionResult {
  const state = EditorState.create({
    doc,
    extensions: [latex(completionData)],
  })
  const result = latexCompletionSource(new CompletionContext(state, doc.length, false))
  expect(result).not.toBeNull()
  return result!
}

function updateCompletion(
  previous: CompletionResult,
  doc: string,
  completionData?: LatexCompletionData,
): CompletionResult {
  expect(previous.update).toBeTypeOf('function')
  const state = EditorState.create({
    doc,
    extensions: [latex(completionData)],
  })
  const result = previous.update!(
    previous,
    previous.from,
    previous.to ?? previous.from,
    new CompletionContext(state, doc.length, false),
  )
  expect(result).not.toBeNull()
  return result!
}

function labelsOf(result: CompletionResult): string[] {
  return result.options.map((option) => option.label)
}

import { describe, expect, it } from 'vitest'
import { EditorState, type Transaction } from '@codemirror/state'
import type { Completion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import {
  findLatexStructuredSnippet,
  latexBeginEnvironmentSnippetCompletions,
  latexCommandSnippetCompletions,
  latexCommandTriggerMatches,
  latexSnippetCommandTriggers,
} from '../features/latex-editor/latex-snippets'
import { completionBoostFor, matchesCompletionQuery } from '../features/latex-editor/latex-completion-data'

describe('latex snippets', () => {
  it('defines structured figure and table snippets', () => {
    const figure = findLatexStructuredSnippet('figure')
    const table = findLatexStructuredSnippet('table')

    expect(figure?.template).toContain('\\begin\\{figure\\}')
    expect(figure?.template).toContain('\\includegraphics')
    expect(figure?.template).toContain('\\caption\\{${3:Caption}\\}')

    expect(table?.template).toContain('\\begin\\{table\\}')
    expect(table?.template).toContain('\\begin\\{tabular\\}')
    expect(table?.template).toContain('\\label\\{tab:${2:label}\\}')
  })

  it('offers command aliases for fast insertion', () => {
    const labels = latexCommandSnippetCompletions('fig').map((item) => item.label)
    expect(labels).toContain('\\fig')

    const triggers = latexSnippetCommandTriggers()
    expect(triggers.has('table')).toBe(true)
    expect(triggers.has('eq')).toBe(true)
  })

  it('keeps contains command matches while ranking prefix matches first', () => {
    const labels = latexCommandSnippetCompletions('sec').map((item) => item.label)
    expect(labels.slice(0, 2)).toEqual(['\\sec', '\\section'])
    expect(latexCommandTriggerMatches('c')).toContain('sec')
    expect(completionBoostFor('cite', 'c')).toBeGreaterThan(completionBoostFor('section', 'c'))
    expect(matchesCompletionQuery('includegraphics', 'graph')).toBe(true)
  })

  it('offers begin-environment snippets by prefix', () => {
    const labels = latexBeginEnvironmentSnippetCompletions('tab').map((item) => item.label)
    expect(labels).toContain('table')
    expect(labels).toContain('tabular')
  })

  it('keeps cite and ref snippet cursors inside empty braces', () => {
    expect(applySnippetCompletion('\\cite', '\\cite')).toEqual({
      doc: '\\cite{}',
      cursor: '\\cite{'.length,
    })
    expect(applySnippetCompletion('\\ref', '\\ref')).toEqual({
      doc: '\\ref{}',
      cursor: '\\ref{'.length,
    })
  })

  it('offers no-argument formatting shortcuts with the cursor after the command', () => {
    const shortcuts = ['noindent', 'indent', 'newpage', 'clearpage', 'smallskip', 'medskip', 'bigskip']

    for (const shortcut of shortcuts) {
      expect(latexSnippetCommandTriggers().has(shortcut)).toBe(true)
      expect(applySnippetCompletion(`\\${shortcut}`, `\\${shortcut}`)).toEqual({
        doc: `\\${shortcut} `,
        cursor: `\\${shortcut} `.length,
      })
    }
  })
})

function applySnippetCompletion(prefix: string, label: string): { doc: string; cursor: number } {
  const completion = latexCommandSnippetCompletions(prefix.replace(/^\\/, ''))
    .find((item) => item.label === label)
  expect(completion).toBeDefined()

  const apply = (completion as Completion).apply
  expect(apply).toBeTypeOf('function')

  let state = EditorState.create({ doc: prefix })
  const editor = {
    get state() {
      return state
    },
    dispatch(transaction: Transaction) {
      state = transaction.state
    },
  } as unknown as EditorView

  ;(apply as Exclude<Completion['apply'], string | undefined>)(
    editor,
    completion as Completion,
    0,
    prefix.length,
  )

  return {
    doc: state.doc.toString(),
    cursor: state.selection.main.head,
  }
}

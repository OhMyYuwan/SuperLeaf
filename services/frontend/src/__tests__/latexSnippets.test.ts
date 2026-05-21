import { describe, expect, it } from 'vitest'
import {
  findLatexStructuredSnippet,
  latexBeginEnvironmentSnippetCompletions,
  latexCommandSnippetCompletions,
  latexCommandTriggerMatches,
  latexSnippetCommandTriggers,
} from '../features/latex-editor/latex-snippets'

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
  })

  it('offers begin-environment snippets by prefix', () => {
    const labels = latexBeginEnvironmentSnippetCompletions('tab').map((item) => item.label)
    expect(labels).toContain('table')
    expect(labels).toContain('tabular')
  })
})

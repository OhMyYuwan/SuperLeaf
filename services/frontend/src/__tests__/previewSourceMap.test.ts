import { describe, expect, it } from 'vitest'
import { previewTextCandidatesNearOffset } from '../services/previewSourceMap'

describe('preview source map helpers', () => {
  it('extracts visible text from LaTeX heading commands', () => {
    const source = '\\section{Introduction and Motivation}\nBody text.'

    expect(previewTextCandidatesNearOffset(source, 3)).toContain('Introduction and Motivation')
  })

  it('uses nearby paragraph words when the cursor line is short', () => {
    const source = [
      'This paragraph explains a collaborative writing workflow with agent review.',
      'It continues with concrete editor feedback and PDF preview navigation.',
      '',
      'Next paragraph.',
    ].join('\n')
    const offset = source.indexOf('continues')

    const candidates = previewTextCandidatesNearOffset(source, offset)

    expect(candidates).toContain(
      'This paragraph explains a collaborative writing workflow with agent review. It continues with concrete editor feedback and PDF preview navigation.',
    )
    expect(candidates).toContain('This paragraph explains collaborative writing workflow with agent')
  })

  it('drops comments and non-visible citation commands from candidates', () => {
    const source = 'Visible claim with evidence \\cite{paper2026}. % hidden note'

    const candidates = previewTextCandidatesNearOffset(source, source.indexOf('claim'))

    expect(candidates[0]).toBe('Visible claim with evidence .')
    expect(candidates.join(' ')).not.toContain('hidden')
    expect(candidates.join(' ')).not.toContain('paper2026')
  })
})

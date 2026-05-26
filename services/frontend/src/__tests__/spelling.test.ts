import { describe, expect, it } from 'vitest'
import { __spellingTest } from '../features/latex-editor/spelling'

describe('spelling word extraction', () => {
  it('extracts prose from LaTeX while skipping commands, refs, URLs, comments, and math', () => {
    const text = [
      '\\section{A collabrative Study}\\citep{smith2024}',
      'Real wrting text with \\textit{emphasized errror}. % hidden mistakke',
      '$x + y = z$ https://example.com/wrng',
    ].join('\n')

    const words = __spellingTest.collectSpellcheckWordsFromText('tex', text).map((word) => word.text)

    expect(words).toEqual([
      'collabrative',
      'Study',
      'Real',
      'wrting',
      'text',
      'with',
      'emphasized',
      'errror',
    ])
  })

  it('extracts Markdown prose while skipping fenced code, inline code, image metadata, and URLs', () => {
    const text = [
      '```ts',
      'const wrng = true',
      '```',
      'A [collabrative link](https://example.com/wrng) with `inlinee` prose wrting.',
      '![mistakke](https://example.com/image.png)',
    ].join('\n')

    const words = __spellingTest.collectSpellcheckWordsFromText('md', text).map((word) => word.text)

    expect(words).toEqual(['collabrative', 'link', 'with', 'prose', 'wrting'])
  })

  it('matches replacement casing', () => {
    expect(__spellingTest.matchCase('collaborative', 'Collabrative')).toBe('Collaborative')
    expect(__spellingTest.matchCase('api', 'API')).toBe('API')
    expect(__spellingTest.matchCase('writer', 'wrter')).toBe('writer')
  })
})

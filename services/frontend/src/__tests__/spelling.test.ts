import { afterEach, describe, expect, it, vi } from 'vitest'
import { __spellingTest } from '../features/latex-editor/spelling'
import { spellingApi } from '../services/spellingApi'

afterEach(() => {
  __spellingTest.resetState()
  vi.restoreAllMocks()
})

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

  it('marks a learned personal dictionary word as correct immediately', async () => {
    vi.spyOn(spellingApi, 'learn').mockResolvedValue({ language: 'en', words: ['ImageNet'] })
    __spellingTest.seedCache('en', 'ImageNet', { correct: false, suggestions: ['immanent'] })
    const refresh = vi.fn()

    const promise = __spellingTest.learnPersonalDictionaryWord('en', 'ImageNet', refresh)

    expect(__spellingTest.cachedMisspellings('en', ['ImageNet']).has('imagenet')).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)

    await promise

    expect(spellingApi.learn).toHaveBeenCalledWith('en', 'ImageNet')
    expect(__spellingTest.cachedMisspellings('en', ['ImageNet']).has('imagenet')).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('rolls back the optimistic spelling cache when personal dictionary save fails', async () => {
    vi.spyOn(spellingApi, 'learn').mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    __spellingTest.seedCache('en', 'ImageNet', { correct: false, suggestions: ['immanent'] })
    const refresh = vi.fn()

    await __spellingTest.learnPersonalDictionaryWord('en', 'ImageNet', refresh)

    expect(__spellingTest.cachedMisspellings('en', ['ImageNet']).get('imagenet')).toEqual({
      word: 'ImageNet',
      suggestions: ['immanent'],
    })
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})

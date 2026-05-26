import type { Extension } from '@codemirror/state'
import { forceLinting, linter, type Diagnostic } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import { spellingApi } from '../../services/spellingApi'
import type { SpellingMisspelling } from '../../services/spellingApi'
import type { EditorFormat } from './extensions'

const DEFAULT_LANGUAGE = 'en'
const MAX_VISIBLE_WORDS = 500
const MAX_ACTION_SUGGESTIONS = 4
const WORD_PATTERN = /[\p{L}][\p{L}'’]*/gu
const RAW_URL_PATTERN = /^(https?:\/\/|www\.)/i

const SPELLING_MARK_CLASS = 'ylw-cm-spelling-error'

type SpellWord = {
  text: string
  from: number
  to: number
}

type SpellCacheEntry = {
  correct: boolean
  suggestions: string[]
}

type MarkdownContext = {
  inFence: boolean
}

type TextSegment = {
  text: string
  offset: number
}

const cache = new Map<string, SpellCacheEntry>()
const ignored = new Set<string>()

export function spellingFor(format: EditorFormat, language = DEFAULT_LANGUAGE): Extension {
  const normalizedLanguage = normalizeLanguage(language)

  return linter(
    async (view) => {
      const words = collectVisibleSpellcheckWords(view, format)
      if (words.length === 0) return []

      const misspellings = await resolveMisspellings(normalizedLanguage, words.map((w) => w.text))
      if (misspellings.size === 0) return []

      return words.flatMap((word) => {
        const misspelling = misspellings.get(wordKey(word.text))
        if (!misspelling) return []
        return [diagnosticForWord(normalizedLanguage, word, misspelling)]
      })
    },
    {
      delay: 1000,
      needsRefresh: (update) => update.docChanged || update.viewportChanged,
    },
  )
}

function collectVisibleSpellcheckWords(view: EditorView, format: EditorFormat): SpellWord[] {
  const out: SpellWord[] = []
  const { doc } = view.state

  for (const range of view.visibleRanges) {
    let pos = doc.lineAt(range.from).from
    const markdownContext: MarkdownContext = {
      inFence: format === 'md' ? markdownFenceOpenBefore(view, range.from) : false,
    }

    while (pos <= range.to) {
      const line = doc.lineAt(pos)
      const from = Math.max(line.from, range.from)
      const to = Math.min(line.to, range.to)
      if (from <= to) {
        out.push(...collectSpellcheckWordsFromLine(format, doc.sliceString(from, to), from, markdownContext))
      }
      if (out.length >= MAX_VISIBLE_WORDS || line.to >= range.to || line.number >= doc.lines) break
      pos = line.to + 1
    }
    if (out.length >= MAX_VISIBLE_WORDS) break
  }

  return dedupeWordsByRange(out).slice(0, MAX_VISIBLE_WORDS)
}

async function resolveMisspellings(language: string, words: string[]): Promise<Map<string, SpellingMisspelling>> {
  const unique = uniqueCheckableWords(language, words)
  if (unique.length === 0) return cachedMisspellings(language, words)

  try {
    const response = await spellingApi.check(language, unique)
    const misspelled = new Map(response.misspellings.map((item) => [wordKey(item.word), item]))
    for (const word of unique) {
      const key = cacheKey(language, word)
      const misspelling = misspelled.get(wordKey(word))
      cache.set(key, {
        correct: !misspelling,
        suggestions: misspelling?.suggestions ?? [],
      })
    }
  } catch {
    return cachedMisspellings(language, words)
  }

  return cachedMisspellings(language, words)
}

function uniqueCheckableWords(language: string, words: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const word of words) {
    const key = cacheKey(language, word)
    if (ignored.has(key) || cache.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length >= MAX_VISIBLE_WORDS) break
  }

  return out
}

function cachedMisspellings(language: string, words: string[]): Map<string, SpellingMisspelling> {
  const out = new Map<string, SpellingMisspelling>()
  for (const word of words) {
    const key = cacheKey(language, word)
    const entry = cache.get(key)
    if (!entry || entry.correct || ignored.has(key)) continue
    out.set(wordKey(word), { word, suggestions: entry.suggestions })
  }
  return out
}

function diagnosticForWord(language: string, word: SpellWord, misspelling: SpellingMisspelling): Diagnostic {
  const actions = misspelling.suggestions
    .slice(0, MAX_ACTION_SUGGESTIONS)
    .map((suggestion) => ({
      name: `改为 ${suggestion}`,
      apply: (view: EditorView, from: number, to: number) => {
        const original = view.state.sliceDoc(from, to)
        const replacement = matchCase(suggestion, original)
        view.dispatch({
          changes: { from, to, insert: replacement },
          selection: { anchor: from + replacement.length },
        })
      },
    }))

  actions.push(
    {
      name: '加入词典',
      apply: (view: EditorView, from: number, to: number) => {
        const current = view.state.sliceDoc(from, to)
        void learnPersonalDictionaryWord(language, current, () => forceLinting(view))
      },
    },
    {
      name: '忽略本次',
      apply: (view: EditorView, from: number, to: number) => {
        ignored.add(cacheKey(language, view.state.sliceDoc(from, to)))
        forceLinting(view)
      },
    },
  )

  return {
    from: word.from,
    to: word.to,
    severity: 'warning',
    source: 'spelling',
    markClass: SPELLING_MARK_CLASS,
    message: `可能的拼写错误: "${word.text}"`,
    actions,
  }
}

async function learnPersonalDictionaryWord(
  language: string,
  word: string,
  refresh: () => void,
): Promise<void> {
  const key = cacheKey(language, word)
  const previous = cache.get(key)
  cache.set(key, { correct: true, suggestions: [] })
  refresh()

  try {
    const response = await spellingApi.learn(language, word)
    markDictionaryWordsCorrect(response.language || language, response.words)
    refresh()
  } catch (error) {
    if (previous) {
      cache.set(key, previous)
    } else {
      cache.delete(key)
    }
    console.warn('[spelling] Failed to save word to personal dictionary:', error)
    refresh()
  }
}

function markDictionaryWordsCorrect(language: string, words: string[]): void {
  for (const word of words) {
    cache.set(cacheKey(language, word), { correct: true, suggestions: [] })
  }
}

function collectSpellcheckWordsFromText(format: EditorFormat, text: string, baseOffset = 0): SpellWord[] {
  const out: SpellWord[] = []
  const markdownContext: MarkdownContext = { inFence: false }
  let lineOffset = baseOffset

  for (const line of text.split('\n')) {
    out.push(...collectSpellcheckWordsFromLine(format, line, lineOffset, markdownContext))
    lineOffset += line.length + 1
  }

  return out
}

function collectSpellcheckWordsFromLine(
  format: EditorFormat,
  line: string,
  baseOffset: number,
  markdownContext: MarkdownContext,
): SpellWord[] {
  const segments = segmentsForLine(format, line, markdownContext)
  const words: SpellWord[] = []

  for (const segment of segments) {
    WORD_PATTERN.lastIndex = 0
    for (let match = WORD_PATTERN.exec(segment.text); match; match = WORD_PATTERN.exec(segment.text)) {
      const text = match[0]
      if (!isFrontendSpellcheckableWord(text)) continue
      words.push({
        text,
        from: baseOffset + segment.offset + match.index,
        to: baseOffset + segment.offset + match.index + text.length,
      })
    }
  }

  return words
}

function segmentsForLine(format: EditorFormat, line: string, markdownContext: MarkdownContext): TextSegment[] {
  if (format === 'tex') return latexTextSegments(line)
  if (format === 'md') return markdownTextSegments(line, markdownContext)
  return plainTextSegments(line)
}

function plainTextSegments(line: string): TextSegment[] {
  return scanTextSegments(line, {
    skipSpecial: (text, index) => rawUrlEnd(text, index),
  })
}

function latexTextSegments(line: string): TextSegment[] {
  return scanTextSegments(line, {
    skipSpecial: (text, index) => {
      const char = text[index]
      if (char === '%') return text.length
      if (char === '\\') return skipLatexCommand(text, index)
      if (char === '$') return skipLatexMath(text, index)
      if ('{}[]&_#^~'.includes(char)) return index + 1
      return rawUrlEnd(text, index)
    },
  })
}

function markdownTextSegments(line: string, context: MarkdownContext): TextSegment[] {
  if (/^\s*(```|~~~)/.test(line)) {
    context.inFence = !context.inFence
    return []
  }
  if (context.inFence) return []

  return scanTextSegments(line, {
    skipSpecial: (text, index) => {
      const char = text[index]
      if (char === '`') return skipUntil(text, index + 1, '`')
      if (char === '!' && text[index + 1] === '[') {
        const afterAlt = skipBracketGroup(text, index + 1, '[', ']')
        return afterAlt < text.length && text[afterAlt] === '('
          ? skipBracketGroup(text, afterAlt, '(', ')')
          : afterAlt
      }
      if (char === ']' && text[index + 1] === '(') return skipBracketGroup(text, index + 1, '(', ')')
      return rawUrlEnd(text, index)
    },
  })
}

function scanTextSegments(
  line: string,
  options: { skipSpecial: (text: string, index: number) => number | null },
): TextSegment[] {
  const segments: TextSegment[] = []
  let start: number | null = null
  let index = 0

  const flush = (end: number) => {
    if (start != null && end > start) {
      segments.push({ text: line.slice(start, end), offset: start })
    }
    start = null
  }

  while (index < line.length) {
    const next = options.skipSpecial(line, index)
    if (next != null && next > index) {
      flush(index)
      index = next
      continue
    }

    if (start == null) start = index
    index += 1
  }

  flush(line.length)
  return segments
}

const LATEX_SKIP_ARGUMENT_COMMANDS = new Set([
  'addbibresource',
  'bibliography',
  'bibliographystyle',
  'begin',
  'cite',
  'citealp',
  'citeauthor',
  'citep',
  'citet',
  'citeyear',
  'documentclass',
  'end',
  'eqref',
  'href',
  'include',
  'includegraphics',
  'input',
  'label',
  'pageref',
  'ref',
  'url',
  'usepackage',
])

function skipLatexCommand(text: string, start: number): number {
  let index = start + 1
  if (index >= text.length) return index

  if (!isAsciiLetter(text[index])) return index + 1
  while (index < text.length && isAsciiLetter(text[index])) index += 1
  const command = text.slice(start + 1, index).toLocaleLowerCase()
  if (text[index] === '*') index += 1

  if (!LATEX_SKIP_ARGUMENT_COMMANDS.has(command)) return index

  let skipped = 0
  while (index < text.length && skipped < 3) {
    index = skipWhitespace(text, index)
    if (text[index] === '[') {
      index = skipBracketGroup(text, index, '[', ']')
      continue
    }
    if (text[index] === '{') {
      index = skipBracketGroup(text, index, '{', '}')
      skipped += 1
      continue
    }
    break
  }
  return index
}

function skipLatexMath(text: string, start: number): number {
  const delimiter = text[start + 1] === '$' ? '$$' : '$'
  const end = text.indexOf(delimiter, start + delimiter.length)
  return end === -1 ? text.length : end + delimiter.length
}

function skipBracketGroup(text: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === open) depth += 1
    if (char === close) {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return text.length
}

function skipUntil(text: string, start: number, delimiter: string): number {
  const end = text.indexOf(delimiter, start)
  return end === -1 ? text.length : end + delimiter.length
}

function rawUrlEnd(text: string, index: number): number | null {
  if (!RAW_URL_PATTERN.test(text.slice(index))) return null
  let end = index
  while (end < text.length && !/\s/.test(text[end])) end += 1
  return end
}

function markdownFenceOpenBefore(view: EditorView, from: number): boolean {
  let open = false
  const text = view.state.sliceDoc(0, from)
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) open = !open
  }
  return open
}

function dedupeWordsByRange(words: SpellWord[]): SpellWord[] {
  const seen = new Set<string>()
  const out: SpellWord[] = []
  for (const word of words) {
    const key = `${word.from}:${word.to}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(word)
  }
  return out
}

function isFrontendSpellcheckableWord(word: string): boolean {
  if (word.length < 2 || word.length > 64) return false
  if (/\d/.test(word)) return false
  if (word === word.toLocaleUpperCase() && word.length > 1) return false
  return /\p{L}/u.test(word)
}

function matchCase(suggestion: string, original: string): string {
  if (original === original.toLocaleUpperCase()) return suggestion.toLocaleUpperCase()
  if (original[0] === original[0]?.toLocaleUpperCase()) {
    return suggestion.charAt(0).toLocaleUpperCase() + suggestion.slice(1)
  }
  return suggestion
}

function normalizeLanguage(language: string): string {
  return (language || DEFAULT_LANGUAGE).trim().toLocaleLowerCase() || DEFAULT_LANGUAGE
}

function cacheKey(language: string, word: string): string {
  return `${normalizeLanguage(language)}:${wordKey(word)}`
}

function wordKey(word: string): string {
  return word.trim().toLocaleLowerCase()
}

function skipWhitespace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index])) index += 1
  return index
}

function isAsciiLetter(char: string): boolean {
  return /^[A-Za-z]$/.test(char)
}

export const __spellingTest = {
  collectSpellcheckWordsFromText,
  cachedMisspellings,
  learnPersonalDictionaryWord,
  matchCase,
  resetState: () => {
    cache.clear()
    ignored.clear()
  },
  seedCache: (language: string, word: string, entry: SpellCacheEntry) => {
    cache.set(cacheKey(language, word), entry)
  },
}

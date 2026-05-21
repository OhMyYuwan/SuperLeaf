export interface LatexCitationCompletion {
  key: string
  detail?: string
  info?: string
  source?: string
}

export interface LatexCompletionData {
  citations: LatexCitationCompletion[]
}

export interface LatexCitationSource {
  name: string
  content: string
}

export interface ParsedBibEntry {
  key: string
  title?: string
  author?: string
  year?: string
  source?: string
}

export interface CitationArgumentContext {
  fromOffset: number
  query: string
  existingKeys: string[]
}

const EMPTY_COMPLETION_DATA: LatexCompletionData = { citations: [] }
const IGNORED_BIB_TYPES = new Set(['comment', 'preamble', 'string'])

export function normalizeLatexCompletionData(
  data?: Partial<LatexCompletionData> | null,
): LatexCompletionData {
  if (!data) return EMPTY_COMPLETION_DATA
  return {
    citations: normalizeCitationCompletions(data.citations ?? []),
  }
}

export function collectLatexCitationCompletions(
  sources: LatexCitationSource[],
): LatexCitationCompletion[] {
  const byKey = new Map<string, LatexCitationCompletion>()

  for (const source of sources) {
    for (const entry of extractBibEntries(source.content, source.name)) {
      if (!entry.key || byKey.has(entry.key)) continue
      byKey.set(entry.key, toCitationCompletion(entry))
    }
    for (const key of extractBibitemKeys(source.content)) {
      if (!key || byKey.has(key)) continue
      byKey.set(key, {
        key,
        detail: source.name ? `bibitem · ${source.name}` : 'bibitem',
        source: source.name,
      })
    }
  }

  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key))
}

export function extractBibEntries(content: string, source = ''): ParsedBibEntry[] {
  const entries: ParsedBibEntry[] = []
  let cursor = 0

  while (cursor < content.length) {
    const at = content.indexOf('@', cursor)
    if (at < 0) break

    const typeMatch = content.slice(at + 1).match(/^\s*([A-Za-z]+)\s*[{(]/)
    if (!typeMatch) {
      cursor = at + 1
      continue
    }

    const type = typeMatch[1].toLowerCase()
    const openIndex = at + typeMatch[0].length
    const open = content[openIndex]
    const close = open === '{' ? '}' : ')'
    const keyStart = skipWhitespace(content, openIndex + 1)
    const keyEnd = readUntil(content, keyStart, ',')

    if (keyEnd <= keyStart) {
      cursor = openIndex + 1
      continue
    }

    const closeIndex = findBalancedClose(content, openIndex, open, close)
    if (closeIndex < 0) {
      cursor = openIndex + 1
      continue
    }

    const key = content.slice(keyStart, keyEnd).trim()
    if (!IGNORED_BIB_TYPES.has(type)) {
      const body = content.slice(keyEnd + 1, closeIndex)
      entries.push({
        key,
        title: readBibField(body, 'title'),
        author: readBibField(body, 'author'),
        year: readBibField(body, 'year'),
        source,
      })
    }

    cursor = closeIndex + 1
  }

  return entries
}

export function extractBibitemKeys(content: string): string[] {
  const keys: string[] = []
  const bibitemRegex = /\\bibitem(?:\[[^\]]*])?\{([^}]+)\}/g
  let match: RegExpExecArray | null
  while ((match = bibitemRegex.exec(content)) !== null) {
    const key = match[1].trim()
    if (key) keys.push(key)
  }
  return keys
}

export function findCitationArgumentContext(
  lineBeforeCursor: string,
): CitationArgumentContext | null {
  const match = lineBeforeCursor.match(
    /\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?(?:\[[^\]]*])*\{([^{}]*)$/i,
  )
  if (!match) return null

  const argumentText = match[1] ?? ''
  const argumentOffset = lineBeforeCursor.length - argumentText.length
  const commaIndex = argumentText.lastIndexOf(',')
  const completedText = commaIndex >= 0 ? argumentText.slice(0, commaIndex) : ''
  const currentSegment = argumentText.slice(commaIndex + 1)
  const leadingWhitespace = currentSegment.match(/^\s*/)?.[0] ?? ''
  const query = currentSegment.slice(leadingWhitespace.length)
  const existingKeys = completedText
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)

  return {
    fromOffset:
      argumentOffset +
      (commaIndex >= 0 ? commaIndex + 1 : 0) +
      leadingWhitespace.length,
    query,
    existingKeys,
  }
}

export function filterCitationCompletions(
  citations: LatexCitationCompletion[],
  query: string,
  existingKeys: string[] = [],
  limit = 200,
): LatexCitationCompletion[] {
  const existing = new Set(existingKeys)
  const normalizedQuery = query.toLowerCase()

  return citations
    .filter((citation) => !existing.has(citation.key))
    .filter((citation) => matchesCompletionQuery(citation.key, normalizedQuery))
    .sort((a, b) =>
      completionBoostFor(b.key, normalizedQuery) - completionBoostFor(a.key, normalizedQuery) ||
      a.key.localeCompare(b.key),
    )
    .slice(0, limit)
}

export function matchesCompletionQuery(value: string, query: string): boolean {
  const normalized = query.toLowerCase()
  if (!normalized) return true
  return value.toLowerCase().includes(normalized)
}

export function completionBoostFor(value: string, query: string, base = 0): number {
  const normalized = query.toLowerCase()
  if (!normalized) return base

  const text = value.toLowerCase()
  if (text.startsWith(normalized)) {
    return base + 100 - Math.min(text.length, 50) / 10
  }

  const index = text.indexOf(normalized)
  if (index >= 0) {
    return base + 20 - Math.min(index, 50) / 10
  }

  return base - 100
}

function normalizeCitationCompletions(
  citations: LatexCitationCompletion[],
): LatexCitationCompletion[] {
  const byKey = new Map<string, LatexCitationCompletion>()
  for (const citation of citations) {
    const key = citation.key.trim()
    if (!key || byKey.has(key)) continue
    byKey.set(key, { ...citation, key })
  }
  return Array.from(byKey.values())
}

function toCitationCompletion(entry: ParsedBibEntry): LatexCitationCompletion {
  const author = compactAuthors(entry.author)
  const detail = [author, entry.year, entry.source].filter(Boolean).join(' · ')
  const info = [entry.title, detail].filter(Boolean).join('\n')
  return {
    key: entry.key,
    detail: detail || entry.source,
    info: info || undefined,
    source: entry.source,
  }
}

function compactAuthors(author?: string): string | undefined {
  if (!author) return undefined
  const authors = author
    .split(/\s+and\s+/i)
    .map((item) => item.trim())
    .filter(Boolean)
  if (authors.length === 0) return undefined
  return authors.length === 1 ? authors[0] : `${authors[0]} et al.`
}

function readBibField(body: string, fieldName: string): string | undefined {
  const match = new RegExp(`\\b${fieldName}\\s*=\\s*`, 'i').exec(body)
  if (!match) return undefined

  const cursor = skipWhitespace(body, match.index + match[0].length)
  if (cursor >= body.length) return undefined

  const open = body[cursor]
  if (open === '{' || open === '"') {
    const valueEnd =
      open === '{'
        ? findBalancedClose(body, cursor, '{', '}')
        : findQuotedClose(body, cursor)
    if (valueEnd < 0) return undefined
    return cleanBibValue(body.slice(cursor + 1, valueEnd))
  }

  const valueEnd = readUntil(body, cursor, ',')
  return cleanBibValue(body.slice(cursor, valueEnd))
}

function cleanBibValue(value: string): string {
  return value
    .replace(/[{}]/g, '')
    .replace(/\\[A-Za-z]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function findBalancedClose(
  text: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0
  let inQuote = false
  for (let index = openIndex; index < text.length; index++) {
    const char = text[index]
    const prev = text[index - 1]
    if (char === '"' && prev !== '\\') inQuote = !inQuote
    if (inQuote) continue
    if (char === open) depth++
    if (char === close) {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function findQuotedClose(text: string, openIndex: number): number {
  for (let index = openIndex + 1; index < text.length; index++) {
    if (text[index] === '"' && text[index - 1] !== '\\') return index
  }
  return -1
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++
  return cursor
}

function readUntil(text: string, start: number, target: string): number {
  const index = text.indexOf(target, start)
  return index < 0 ? text.length : index
}

export interface LatexCitationCompletion {
  key: string
  detail?: string
  info?: string
  source?: string
  title?: string
  author?: string
  year?: string
}

export interface LatexFilePathCompletion {
  path: string
  kind: 'include' | 'graphic' | 'bib'
}

export interface LatexLabelCompletion {
  key: string
  source?: string
}

export interface LatexCompletionData {
  citations: LatexCitationCompletion[]
  filePaths: LatexFilePathCompletion[]
  labels: LatexLabelCompletion[]
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

const EMPTY_COMPLETION_DATA: LatexCompletionData = { citations: [], filePaths: [], labels: [] }
const IGNORED_BIB_TYPES = new Set(['comment', 'preamble', 'string'])
const NO_MATCH = Number.NEGATIVE_INFINITY

export function normalizeLatexCompletionData(
  data?: Partial<LatexCompletionData> | null,
): LatexCompletionData {
  if (!data) return EMPTY_COMPLETION_DATA
  return {
    citations: normalizeCitationCompletions(data.citations ?? []),
    filePaths: data.filePaths ?? [],
    labels: data.labels ?? [],
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
  const normalizedQuery = normalizeCompletionQuery(query)

  return citations
    .filter((citation) => !existing.has(citation.key))
    .map((citation) => ({
      citation,
      score: scoreCitationCompletion(citation, normalizedQuery),
    }))
    .filter((item) => item.score > NO_MATCH)
    .sort((a, b) => b.score - a.score || a.citation.key.localeCompare(b.citation.key))
    .map((item) => item.citation)
    .slice(0, limit)
}

export function matchesCompletionQuery(value: string, query: string): boolean {
  return completionMatchScore(value, query) > NO_MATCH
}

export function completionBoostFor(value: string, query: string, base = 0): number {
  const score = completionMatchScore(value, query)
  return score > NO_MATCH ? base + score : base - 1000
}

export function completionMatchScore(value: string | undefined, query: string): number {
  const normalized = normalizeCompletionQuery(query)
  if (!normalized) return 0
  if (!value) return NO_MATCH

  const text = value.toLowerCase()
  if (text === normalized) {
    return 700
  }
  if (text.startsWith(normalized)) {
    return 620 - lengthPenalty(text)
  }

  const wordPrefixIndex = findWordPrefixIndex(value, normalized)
  if (wordPrefixIndex >= 0) {
    return 520 - wordPrefixIndex * 4 - lengthPenalty(text)
  }

  const containsIndex = text.indexOf(normalized)
  if (containsIndex >= 0) {
    return 400 - Math.min(containsIndex, 80) - lengthPenalty(text)
  }

  const acronym = acronymFor(value)
  if (acronym.startsWith(normalized)) {
    return 320 - lengthPenalty(acronym)
  }

  if (normalized.length >= 3) {
    const fuzzy = fuzzyMatchScore(text, normalized)
    if (fuzzy > NO_MATCH) {
      return 220 + fuzzy - lengthPenalty(text)
    }
  }

  return NO_MATCH
}

export function scoreCitationCompletion(
  citation: LatexCitationCompletion,
  query: string,
): number {
  const tokens = tokenizeCompletionQuery(query)
  if (tokens.length === 0) return 0

  let score = 0
  for (const token of tokens) {
    const tokenScore = Math.max(
      weightedCompletionScore(citation.key, token, 1600),
      weightedCompletionScore(citation.title, token, 900),
      weightedCompletionScore(citation.author, token, 760),
      weightedCompletionScore(citation.year, token, 650),
      weightedCompletionScore(citation.source, token, 300),
      weightedCompletionScore(citation.detail, token, 260),
    )
    if (tokenScore <= NO_MATCH) return NO_MATCH
    score += tokenScore
  }
  return score
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
    title: entry.title,
    author: entry.author,
    year: entry.year,
  }
}

function normalizeCompletionQuery(query: string): string {
  return query.replace(/^\\+/, '').trim().toLowerCase()
}

function tokenizeCompletionQuery(query: string): string[] {
  const normalized = normalizeCompletionQuery(query)
  if (!normalized) return []
  return normalized.split(/\s+/).filter(Boolean)
}

function weightedCompletionScore(
  value: string | undefined,
  query: string,
  weight: number,
): number {
  const score = completionMatchScore(value, query)
  return score > NO_MATCH ? weight + score : NO_MATCH
}

function findWordPrefixIndex(value: string, query: string): number {
  const parts = value.split(/[\s._:@/\\-]+/).filter(Boolean)
  let offset = 0
  for (const part of parts) {
    if (part.toLowerCase().startsWith(query)) return offset
    offset += part.length + 1
  }
  return -1
}

function acronymFor(value: string): string {
  return value
    .split(/[\s._:@/\\-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toLowerCase() ?? '')
    .join('')
}

function fuzzyMatchScore(text: string, query: string): number {
  let textIndex = 0
  let runLength = 0
  let score = 0

  for (const queryChar of query) {
    const found = text.indexOf(queryChar, textIndex)
    if (found < 0) return NO_MATCH
    if (found === textIndex) {
      runLength += 1
      score += 8 + runLength * 2
    } else {
      runLength = 0
      score += Math.max(1, 8 - Math.min(found - textIndex, 7))
    }
    textIndex = found + 1
  }

  return score
}

function lengthPenalty(text: string): number {
  return Math.min(text.length, 80) / 12
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

const GRAPHIC_EXTENSIONS = /\.(eps|jpe?g|gif|png|tiff?|pdf|svg)$/i
const INCLUDE_EXTENSIONS = /\.(?:tex|txt)$/i
const BIB_EXTENSIONS = /\.bib$/i

export interface FilePathTreeFolder {
  name: string
  folders: FilePathTreeFolder[]
  docs: { name: string }[]
  files: { name: string }[]
}

export function collectLatexFilePaths(root: FilePathTreeFolder): LatexFilePathCompletion[] {
  const out: LatexFilePathCompletion[] = []

  const walk = (folder: FilePathTreeFolder, prefix: string) => {
    for (const doc of folder.docs) {
      const path = prefix ? `${prefix}/${doc.name}` : doc.name
      if (INCLUDE_EXTENSIONS.test(doc.name)) {
        out.push({ path: path.replace(/\.tex$/, ''), kind: 'include' })
      }
      if (BIB_EXTENSIONS.test(doc.name)) {
        out.push({ path: path.replace(/\.bib$/, ''), kind: 'bib' })
      }
    }
    for (const file of folder.files) {
      const path = prefix ? `${prefix}/${file.name}` : file.name
      if (GRAPHIC_EXTENSIONS.test(file.name)) {
        out.push({ path, kind: 'graphic' })
      }
    }
    for (const child of folder.folders) {
      const childPrefix = prefix ? `${prefix}/${child.name}` : child.name
      walk(child, childPrefix)
    }
  }

  walk(root, '')
  return out
}

export interface LatexLabelSource {
  name: string
  content: string
}

export function collectLatexLabels(sources: LatexLabelSource[]): LatexLabelCompletion[] {
  const byKey = new Map<string, LatexLabelCompletion>()
  const labelRegex = /\\label\{([^}]+)\}/g

  for (const source of sources) {
    let match: RegExpExecArray | null
    while ((match = labelRegex.exec(source.content)) !== null) {
      const key = match[1].trim()
      if (key && !byKey.has(key)) {
        byKey.set(key, { key, source: source.name })
      }
    }
  }

  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key))
}

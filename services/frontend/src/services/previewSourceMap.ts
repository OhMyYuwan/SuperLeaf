export interface SourceJump {
  pos: number
  selectText?: string
}

interface MarkdownTokenWithMap {
  map: [number, number] | null
  nesting: number
  attrSet: (name: string, value: string) => void
}

export function stampMarkdownSourceLines(tokens: MarkdownTokenWithMap[]) {
  for (const token of tokens) {
    if (!token.map) continue
    if (token.nesting === -1) continue
    token.attrSet('data-source-line', String(token.map[0]))
  }
}

export function lineToOffset(source: string, line: number): number {
  if (line <= 0) return 0
  let currentLine = 0
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) !== 10) continue
    currentLine += 1
    if (currentLine >= line) return i + 1
  }
  return source.length
}

export function sourceJumpFromMarkdownElement(
  source: string,
  target: EventTarget | null,
): SourceJump | null {
  if (!(target instanceof Element)) return null
  const sourceElement = target.closest<HTMLElement>('[data-source-line]')
  if (!sourceElement) return null
  const line = Number(sourceElement.dataset.sourceLine)
  if (!Number.isFinite(line)) return null
  return { pos: lineToOffset(source, line) }
}

export function sourceJumpFromPreviewText(
  source: string,
  rawText: string | null | undefined,
): SourceJump | null {
  const candidates = getLookupCandidates(rawText)
  for (const candidate of candidates) {
    const exact = source.toLocaleLowerCase().indexOf(candidate.toLocaleLowerCase())
    if (exact >= 0) return { pos: exact, selectText: source.slice(exact, exact + candidate.length) }

    const normalized = findNormalized(source, candidate)
    if (normalized) return normalized
  }
  return null
}

function getLookupCandidates(rawText: string | null | undefined): string[] {
  const text = (rawText ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return []

  const words = text
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((word) => word.length >= 3)

  return Array.from(new Set([text, ...words])).filter((item) => item.length >= 2)
}

function findNormalized(source: string, candidate: string): SourceJump | null {
  const sourceIndex = buildNormalizedIndex(source)
  const target = normalizeForLookup(candidate)
  if (target.length < 2) return null

  const normalizedOffset = sourceIndex.text.indexOf(target)
  if (normalizedOffset < 0) return null

  const from = sourceIndex.sourceOffsets[normalizedOffset] ?? 0
  const toNormalized = Math.min(
    normalizedOffset + target.length - 1,
    sourceIndex.sourceOffsets.length - 1,
  )
  const to = (sourceIndex.sourceOffsets[toNormalized] ?? from) + 1
  return { pos: from, selectText: source.slice(from, to) }
}

function buildNormalizedIndex(source: string): { text: string; sourceOffsets: number[] } {
  let text = ''
  const sourceOffsets: number[] = []
  for (let i = 0; i < source.length; i += 1) {
    const normalized = normalizeForLookup(source[i])
    if (!normalized) continue
    text += normalized
    for (let j = 0; j < normalized.length; j += 1) {
      sourceOffsets.push(i)
    }
  }
  return { text, sourceOffsets }
}

function normalizeForLookup(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

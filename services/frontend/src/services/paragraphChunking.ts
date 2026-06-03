/**
 * paragraphChunking — shared paragraph chunking utilities.
 *
 * Used by both writingStore (polish-paragraphs, draft) and automationStore
 * (auto-review). Extracted to eliminate duplication and ensure consistent
 * paragraph boundary logic.
 */

import type { Document, Paragraph, Section } from '../types/document'

// ── Regex constants ──────────────────────────────────────────

export const AUTO_MARKER_RE = /^\s*%\s*AUTO\b/im
export const LATEX_BEGIN_DOCUMENT_RE = /\\begin\s*\{\s*document\s*\}/i

// ── Types ────────────────────────────────────────────────────

export interface ParagraphChunk {
  index: number
  total: number
  range: { from: number; to: number }
  text: string
  sectionTitle: string
}

/** Chunk without index/total — used internally during splitting. */
export type RawChunk = Omit<ParagraphChunk, 'index' | 'total'>

// ── Public API ───────────────────────────────────────────────

/**
 * Build paragraph chunks for the given document, splitting any paragraph
 * longer than ``maxChars`` into sub-chunks at natural break points.
 */
export function buildParagraphChunks(doc: Document, maxChars: number): ParagraphChunk[] {
  const paragraphs = [...(doc.structure.paragraphs ?? [])]
    .filter((p) => p.text.trim().length > 0)
    .filter((p) => shouldIncludeParagraph(doc, p))
    .sort((a, b) => a.range.from - b.range.from)

  const raw = paragraphs.flatMap((p) => splitParagraph(doc, p, maxChars))
  return raw.map((c, idx) => ({ ...c, index: idx + 1, total: raw.length }))
}

/**
 * Count paragraphs that would be included in chunking (useful for progress
 * indicators before actually building chunks).
 */
export function countChunkableParagraphs(doc: Document): number {
  return (doc.structure.paragraphs ?? [])
    .filter((p) => p.text.trim().length > 0)
    .filter((p) => shouldIncludeParagraph(doc, p))
    .length
}

/**
 * Decide whether a paragraph should be included in chunking.
 * Excludes empty paragraphs, preamble content, and bare LaTeX environment
 * command lines.
 */
export function shouldIncludeParagraph(doc: Document, paragraph: Paragraph): boolean {
  const text = paragraph.text.trim()
  if (!text) return false
  if (AUTO_MARKER_RE.test(text)) return true
  if (doc.format !== 'tex') return true
  if (isBeforeLatexDocumentBody(doc.content, paragraph.range)) return false
  // Exclude pure LaTeX environment command lines (e.g. \begin{figure}...\end{figure})
  if (/^\\(begin|end)\s*\{/.test(text) && text.split('\n').length <= 2) return false
  return true
}

/**
 * Check whether a range falls before the ``\begin{document}`` marker
 * (i.e. in the LaTeX preamble).
 */
export function isBeforeLatexDocumentBody(
  content: string,
  range: { from: number; to: number },
): boolean {
  const match = LATEX_BEGIN_DOCUMENT_RE.exec(content)
  if (!match) return false
  const bodyStart = match.index + match[0].length
  return range.to <= bodyStart
}

// ── Internal helpers ─────────────────────────────────────────

function splitParagraph(
  doc: Document,
  paragraph: Paragraph,
  maxChars: number,
): RawChunk[] {
  if (paragraph.text.length <= maxChars) {
    return [{
      range: paragraph.range,
      text: paragraph.text,
      sectionTitle: sectionTitleAt(doc.structure.sections, paragraph.range.from),
    }]
  }
  const out: RawChunk[] = []
  let cursor = paragraph.range.from
  while (cursor < paragraph.range.to) {
    const desiredEnd = Math.min(cursor + maxChars, paragraph.range.to)
    const end = findSplitPoint(doc.content, cursor, desiredEnd, paragraph.range.to)
    out.push({
      range: { from: cursor, to: end },
      text: doc.content.slice(cursor, end),
      sectionTitle: sectionTitleAt(doc.structure.sections, cursor),
    })
    cursor = skipWhitespace(doc.content, end, paragraph.range.to)
  }
  return out
}

function findSplitPoint(
  content: string,
  from: number,
  desiredEnd: number,
  maxEnd: number,
): number {
  if (desiredEnd >= maxEnd) return maxEnd
  const window = content.slice(from, desiredEnd)
  const candidates = ['\n', '。', '.', ';', '；', ',', '，', ' ']
  for (const marker of candidates) {
    const idx = window.lastIndexOf(marker)
    if (idx > Math.floor(window.length * 0.45)) {
      return from + idx + marker.length
    }
  }
  return desiredEnd
}

function skipWhitespace(content: string, from: number, maxEnd: number): number {
  let pos = from
  while (pos < maxEnd && /\s/.test(content[pos] ?? '')) pos += 1
  return pos
}

function sectionTitleAt(sections: Section[], pos: number): string {
  let best: Section | undefined
  for (const section of sections) {
    if (pos >= section.range.from && pos < section.range.to) {
      if (!best || section.level > best.level) best = section
    }
  }
  return best?.title ?? ''
}

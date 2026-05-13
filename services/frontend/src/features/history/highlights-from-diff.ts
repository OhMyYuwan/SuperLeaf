/**
 * Project an Overleaf-shaped diff onto a single rendered string + decoration
 * specs the CodeMirror highlights extension can consume.
 *
 * The unified view concatenates parts in order: unchanged text stays, then
 * the *deleted* text from version A is shown (rendered with strikethrough),
 * then the *inserted* text from version B is shown (rendered with green
 * background). This matches Overleaf's `historyDoc.ts` projection so we get
 * the same "deletion appears just before its insertion" affordance the
 * Overleaf history viewer uses.
 */

import type { DiffPart } from '../../services/versionApi'

export type HighlightKind = 'insertion' | 'deletion'

export interface HighlightSpec {
  from: number
  to: number
  kind: HighlightKind
  startTs?: number
}

export interface ProjectedDiff {
  text: string
  highlights: HighlightSpec[]
}

export function projectDiffToText(parts: DiffPart[]): ProjectedDiff {
  let cursor = 0
  let text = ''
  const highlights: HighlightSpec[] = []

  for (const part of parts) {
    if ('u' in part) {
      text += part.u
      cursor += part.u.length
      continue
    }
    if ('d' in part) {
      const len = part.d.length
      if (len > 0) {
        highlights.push({
          from: cursor,
          to: cursor + len,
          kind: 'deletion',
          startTs: part.meta?.start_ts,
        })
        text += part.d
        cursor += len
      }
      continue
    }
    if ('i' in part) {
      const len = part.i.length
      if (len > 0) {
        highlights.push({
          from: cursor,
          to: cursor + len,
          kind: 'insertion',
          startTs: part.meta?.start_ts,
        })
        text += part.i
        cursor += len
      }
      continue
    }
  }

  return { text, highlights }
}

/**
 * Collapse adjacent highlight runs of the same kind. The backend already
 * compresses parts but the projection above can split a single edit across
 * `d` + `i` boundaries we want to navigate as one location.
 */
export function highlightLocations(highlights: HighlightSpec[]): HighlightSpec[] {
  // For navigation purposes, the user expects one "stop" per edit cluster:
  // adjacent d/i (or just d, or just i) treated as one location. We merge
  // any highlights whose ranges touch (`a.to === b.from`).
  const sorted = [...highlights].sort((a, b) => a.from - b.from)
  const out: HighlightSpec[] = []
  for (const h of sorted) {
    const prev = out[out.length - 1]
    if (prev && prev.to === h.from) {
      prev.to = h.to
      if (h.startTs !== undefined && (prev.startTs === undefined || h.startTs < prev.startTs)) {
        prev.startTs = h.startTs
      }
      continue
    }
    out.push({ ...h })
  }
  return out
}

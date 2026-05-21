/**
 * rangeTracker — pure functions that shift annotation ranges when the
 * underlying document changes. Inspired by Overleaf's RangesTracker
 * (reference/overleaf/libraries/ranges-tracker/index.cjs:239-301).
 *
 * A DocChange represents a single atomic edit: delete [from, to) then insert
 * `insertLen` characters at `from`. Multiple changes in one transaction are
 * applied sequentially (CodeMirror guarantees they don't overlap within a
 * single ChangeSet iteration).
 */

export interface DocChange {
  from: number
  to: number
  insertLen: number
}

export interface Range {
  from: number
  to: number
}

function collapsedAt(pos: number): Range {
  return { from: Math.max(0, pos), to: Math.max(0, pos) }
}

function rangeForEngulfingChange(change: DocChange): Range {
  if (change.insertLen > 0) {
    return { from: change.from, to: change.from + change.insertLen }
  }
  return collapsedAt(change.from)
}

/**
 * Map a single range through a single change.
 *
 * Deleted annotation text is not treated as a destroyed annotation. Instead,
 * the range collapses to the edit boundary, preserving the card/thread while
 * leaving a zero-width editor anchor. If the edit replaces the full selection,
 * the annotation follows the inserted text.
 */
export function mapRange(range: Range, change: DocChange): Range {
  const deleteLen = change.to - change.from
  const shift = change.insertLen - deleteLen

  // Collapsed anchors track like cursor positions. Inserting exactly at the
  // anchor is considered "before" it so the marker stays after the inserted
  // text, matching how Overleaf-style anchors feel during continued editing.
  if (range.to <= range.from) {
    if (change.to <= range.from) {
      return collapsedAt(range.from + shift)
    }
    if (change.from <= range.from && change.to > range.from) {
      return collapsedAt(change.from + change.insertLen)
    }
    return collapsedAt(range.from)
  }

  // 1. Change entirely after range → no effect
  if (change.from >= range.to) return range

  // 2. Change entirely before range → shift both endpoints
  if (change.to <= range.from) {
    return { from: range.from + shift, to: range.to + shift }
  }

  // 3. Change engulfs entire range → collapse or follow replacement text
  if (change.from <= range.from && change.to >= range.to) {
    return rangeForEngulfingChange(change)
  }

  // 4. Change entirely inside range → expand/shrink range end
  if (change.from >= range.from && change.to <= range.to) {
    const next = { from: range.from, to: range.to + shift }
    return next.to > next.from ? next : collapsedAt(change.from)
  }

  // 5. Partial overlap — left side eaten
  if (change.from < range.from && change.to < range.to) {
    const newFrom = change.from + change.insertLen
    const newTo = range.to + shift
    return newTo > newFrom ? { from: newFrom, to: newTo } : collapsedAt(newFrom)
  }

  // 6. Partial overlap — right side eaten
  if (change.from > range.from && change.from < range.to) {
    return { from: range.from, to: change.from }
  }

  return range
}

/**
 * Map a range through a sequence of changes (one transaction).
 * Changes must be in document order (CodeMirror guarantees this).
 */
export function mapRangeThrough(range: Range, changes: DocChange[]): Range {
  let current: Range = range
  for (const c of changes) {
    current = mapRange(current, c)
  }
  return current
}

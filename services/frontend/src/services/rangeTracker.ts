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

/**
 * Map a single range through a single change. Returns the new range, or null
 * if the change completely engulfs the range (annotation should be superseded).
 */
export function mapRange(range: Range, change: DocChange): Range | null {
  const deleteLen = change.to - change.from
  const shift = change.insertLen - deleteLen

  // 1. Change entirely after range → no effect
  if (change.from >= range.to) return range

  // 2. Change entirely before range → shift both endpoints
  if (change.to <= range.from) {
    return { from: range.from + shift, to: range.to + shift }
  }

  // 3. Change engulfs entire range → range destroyed
  if (change.from <= range.from && change.to >= range.to) {
    return null
  }

  // 4. Change entirely inside range → expand/shrink range end
  if (change.from >= range.from && change.to <= range.to) {
    return { from: range.from, to: range.to + shift }
  }

  // 5. Partial overlap — left side eaten
  if (change.from < range.from && change.to < range.to) {
    const newFrom = change.from + change.insertLen
    const newTo = range.to + shift
    return newTo > newFrom ? { from: newFrom, to: newTo } : null
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
export function mapRangeThrough(range: Range, changes: DocChange[]): Range | null {
  let current: Range | null = range
  for (const c of changes) {
    if (!current) return null
    current = mapRange(current, c)
  }
  return current
}

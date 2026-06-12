export interface RecoverableAnnotationRange {
  from: number
  to: number
}

export interface RecoverableAnnotation {
  id: string
  kind?: string
  range: RecoverableAnnotationRange
  targetText?: string
  original?: string
}

export type AnnotationRangeRecoveryStatus = 'stable' | 'recovered' | 'needs_review'

export interface AnnotationRangeRecoveryCandidate {
  range: RecoverableAnnotationRange
  confidence: number
  matchType: 'exact' | 'fuzzy'
  preview: string
}

export interface AnnotationRangeRecoveryResult {
  annotationId: string
  status: AnnotationRangeRecoveryStatus
  range: RecoverableAnnotationRange
  confidence: number
  reason: string
  candidates: AnnotationRangeRecoveryCandidate[]
}

const EXACT_UNIQUE_CONFIDENCE = 0.98
const EXACT_NEAREST_CONFIDENCE = 0.9
const FUZZY_WINDOW_RADIUS = 600
const FUZZY_MAX_ANCHOR_CHARS = 240
const FUZZY_TEXT_THRESHOLD = 0.68
const FUZZY_CONFIDENCE_THRESHOLD = 0.82

export function recoverAnnotationRange(
  annotation: RecoverableAnnotation,
  currentText: string,
): AnnotationRangeRecoveryResult {
  const anchor = anchorTextFor(annotation)
  const safeRange = clampRange(annotation.range, currentText.length)
  if (!anchor) {
    return result(annotation.id, 'needs_review', safeRange, 0, 'missing_anchor_text', [])
  }

  if (currentText.slice(safeRange.from, safeRange.to) === anchor) {
    return result(annotation.id, 'stable', safeRange, 1, 'current_range_matches_anchor', [])
  }

  const exact = exactCandidates(anchor, currentText, annotation.range)
  if (exact.length === 1) {
    return result(annotation.id, 'recovered', exact[0].range, EXACT_UNIQUE_CONFIDENCE, 'unique_exact_match', exact)
  }
  if (exact.length > 1) {
    const sorted = [...exact].sort((a, b) => distanceFromOld(a.range, annotation.range) - distanceFromOld(b.range, annotation.range))
    const nearestDistance = distanceFromOld(sorted[0].range, annotation.range)
    const nextDistance = distanceFromOld(sorted[1].range, annotation.range)
    const clearGap = Math.max(20, anchor.length)
    if (nextDistance - nearestDistance >= clearGap) {
      return result(annotation.id, 'recovered', sorted[0].range, EXACT_NEAREST_CONFIDENCE, 'nearest_exact_match', sorted)
    }
    return result(annotation.id, 'needs_review', safeRange, 0.5, 'ambiguous_exact_matches', sorted)
  }

  const fuzzy = fuzzyCandidates(anchor, currentText, annotation.range)
  const best = fuzzy[0]
  if (best && best.confidence >= FUZZY_CONFIDENCE_THRESHOLD) {
    return result(annotation.id, 'recovered', best.range, best.confidence, 'nearby_fuzzy_match', fuzzy)
  }

  return result(annotation.id, 'needs_review', safeRange, best?.confidence ?? 0, 'no_confident_match', fuzzy)
}

function anchorTextFor(annotation: RecoverableAnnotation): string {
  const original = (annotation.original ?? '').trim()
  const targetText = (annotation.targetText ?? '').trim()
  if (annotation.kind === 'suggestion' && original) return original
  return targetText || original
}

function result(
  annotationId: string,
  status: AnnotationRangeRecoveryStatus,
  range: RecoverableAnnotationRange,
  confidence: number,
  reason: string,
  candidates: AnnotationRangeRecoveryCandidate[],
): AnnotationRangeRecoveryResult {
  return {
    annotationId,
    status,
    range,
    confidence: roundConfidence(confidence),
    reason,
    candidates: candidates.slice(0, 5),
  }
}

function exactCandidates(
  anchor: string,
  currentText: string,
  oldRange: RecoverableAnnotationRange,
): AnnotationRangeRecoveryCandidate[] {
  const out: AnnotationRangeRecoveryCandidate[] = []
  let index = currentText.indexOf(anchor)
  while (index !== -1) {
    const range = { from: index, to: index + anchor.length }
    out.push({
      range,
      confidence: EXACT_UNIQUE_CONFIDENCE,
      matchType: 'exact',
      preview: currentText.slice(range.from, range.to),
    })
    index = currentText.indexOf(anchor, index + 1)
  }
  return out.sort((a, b) => distanceFromOld(a.range, oldRange) - distanceFromOld(b.range, oldRange))
}

function fuzzyCandidates(
  anchor: string,
  currentText: string,
  oldRange: RecoverableAnnotationRange,
): AnnotationRangeRecoveryCandidate[] {
  if (anchor.length < 8) return []
  const shortenedAnchor = anchor.slice(0, FUZZY_MAX_ANCHOR_CHARS)
  const anchorLength = shortenedAnchor.length
  const searchStart = Math.max(0, oldRange.from - FUZZY_WINDOW_RADIUS)
  const searchEnd = Math.min(currentText.length, oldRange.to + FUZZY_WINDOW_RADIUS)
  const lengthDelta = Math.max(4, Math.ceil(anchorLength * 0.25))
  const lengths = uniqueNumbers([
    anchorLength,
    Math.max(1, anchorLength - lengthDelta),
    anchorLength + lengthDelta,
  ])

  const candidates: AnnotationRangeRecoveryCandidate[] = []
  for (let pos = searchStart; pos < searchEnd; pos += 1) {
    for (const length of lengths) {
      const to = Math.min(currentText.length, pos + length)
      if (to <= pos) continue
      const slice = currentText.slice(pos, to)
      const textScore = textSimilarity(shortenedAnchor, slice)
      if (textScore < FUZZY_TEXT_THRESHOLD) continue
      const proximity = proximityScore(pos, oldRange.from)
      const confidence = (textScore * 0.65) + (proximity * 0.35)
      candidates.push({
        range: { from: pos, to },
        confidence: roundConfidence(confidence),
        matchType: 'fuzzy',
        preview: slice,
      })
    }
  }

  return candidates
    .sort((a, b) => b.confidence - a.confidence || span(a.range) - span(b.range))
    .filter((candidate, index, list) => index === list.findIndex((item) => rangesOverlap(item.range, candidate.range)))
    .slice(0, 5)
}

function textSimilarity(a: string, b: string): number {
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const affix = affixSimilarity(left, right)
  const dice = bigramDice(left, right)
  return Math.max(affix, dice)
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function affixSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return (prefix + suffix) / max
}

function bigramDice(a: string, b: string): number {
  const aBigrams = bigramCounts(a)
  const bBigrams = bigramCounts(b)
  let overlap = 0
  for (const [key, count] of aBigrams) {
    overlap += Math.min(count, bBigrams.get(key) ?? 0)
  }
  const total = Math.max(1, Math.max(0, a.length - 1) + Math.max(0, b.length - 1))
  return (2 * overlap) / total
}

function bigramCounts(value: string): Map<string, number> {
  const out = new Map<string, number>()
  if (value.length < 2) {
    out.set(value, 1)
    return out
  }
  for (let i = 0; i < value.length - 1; i += 1) {
    const key = value.slice(i, i + 2)
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

function clampRange(range: RecoverableAnnotationRange, length: number): RecoverableAnnotationRange {
  const from = Math.max(0, Math.min(range.from, length))
  const to = Math.max(from, Math.min(range.to, length))
  return { from, to }
}

function distanceFromOld(range: RecoverableAnnotationRange, oldRange: RecoverableAnnotationRange): number {
  return Math.abs(range.from - oldRange.from)
}

function proximityScore(candidateFrom: number, oldFrom: number): number {
  return Math.max(0, 1 - (Math.abs(candidateFrom - oldFrom) / (FUZZY_WINDOW_RADIUS + 1)))
}

function span(range: RecoverableAnnotationRange): number {
  return Math.max(0, range.to - range.from)
}

function rangesOverlap(a: RecoverableAnnotationRange, b: RecoverableAnnotationRange): boolean {
  return a.from < b.to && b.from < a.to
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b)
}

function roundConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000))
}

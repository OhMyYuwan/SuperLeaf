/**
 * agentQuality — derive per-Agent quality stats from the local
 * annotationStore (V3 Phase 4 task 4.4).
 *
 * Orthogonal to `statsApi.forProvider`:
 *   - stats API (3.4) = quantity view (runs, accept rate from Operation
 *     log, avg latency) — counts Agent activity.
 *   - this helper (4.4) = quality view (user verdicts, top tag) — counts
 *     how useful the Agent's outputs were *according to the user*.
 */

import type {
  AgentEvaluation,
  AnnotationItem,
} from '../stores/annotationStore'

export interface AgentQualityStat {
  positive: number
  negative: number
  total: number
  /** positive / total, or null when total === 0. */
  positiveRate: number | null
  topTag: string | null
  topTagCount: number
}

const EMPTY: AgentQualityStat = {
  positive: 0,
  negative: 0,
  total: 0,
  positiveRate: null,
  topTag: null,
  topTagCount: 0,
}

export function computeAgentQuality(
  workflowId: string,
  annotations: Record<string, AnnotationItem>,
  evaluationsByAnnotation: Record<string, AgentEvaluation[]>,
): AgentQualityStat {
  if (!workflowId) return EMPTY

  let positive = 0
  let negative = 0
  const tagCounts = new Map<string, number>()

  for (const [annotationId, evaluations] of Object.entries(evaluationsByAnnotation)) {
    const item = annotations[annotationId]
    if (!item || item.workflowId !== workflowId) continue
    for (const ev of evaluations) {
      if (ev.verdict === 'positive') positive++
      else if (ev.verdict === 'negative') negative++
      for (const tag of ev.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
      }
    }
  }

  const total = positive + negative
  if (total === 0) return EMPTY

  let topTag: string | null = null
  let topTagCount = 0
  for (const [tag, count] of tagCounts) {
    if (count > topTagCount) {
      topTag = tag
      topTagCount = count
    }
  }

  return {
    positive,
    negative,
    total,
    positiveRate: positive / total,
    topTag,
    topTagCount,
  }
}

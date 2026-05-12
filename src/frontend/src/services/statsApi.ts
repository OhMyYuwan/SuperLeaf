/**
 * statsApi — typed client for the per-provider agent usage stats endpoint
 * (V3 Phase 3 task 3.4).
 *
 * Returned numbers come from two sources merged server-side:
 *   - WorkflowRun (status=completed) for run count and avg latency
 *   - Operation (accept_suggestion / reject_suggestion) for accept rate
 *
 * `accept_rate` and `avg_latency_ms` are nullable: the agent simply hasn't
 * accumulated enough data yet.
 */

import { http } from './backendApi'

export interface AgentStat {
  workflow_id: string
  workflow_name: string
  runs: number
  accepts: number
  rejects: number
  accept_rate: number | null
  avg_latency_ms: number | null
}

export interface ProviderStats {
  provider_id: string
  agents: AgentStat[]
}

export const statsApi = {
  forProvider: (providerId: string) =>
    http<ProviderStats>(`/api/providers/${encodeURIComponent(providerId)}/stats`),
}

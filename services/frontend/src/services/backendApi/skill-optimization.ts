/**
 * Skill Optimization API — data-driven Skill generation pipeline.
 */

import { http } from './client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OptimizationRun {
  id: string
  data_project_id: string
  skill_id: string
  skill_project_id: string
  user_id: string
  status: 'collecting' | 'diagnosing' | 'generating' | 'evaluating' | 'reviewing' | 'published' | 'discarded'
  signal_sources: Record<string, unknown>
  signal_snapshot: Record<string, unknown>
  diagnosis: DiagnosisResult
  generated_artifacts: Artifact[]
  eval_results: Record<string, unknown>
  diff_from_previous: string
  review_status: 'pending' | 'approved' | 'rejected'
  review_notes: string
  created_at: string
  updated_at: string
}

export interface DiagnosisResult {
  failure_patterns: FailurePattern[]
  golden_examples: Example[]
  negative_examples: Example[]
  workflow_patterns: WorkflowPattern[]
  sedimentation_candidates: SedimentationCandidate[]
  optimization_suggestions: OptimizationSuggestion[]
  summary: Record<string, unknown>
}

export interface FailurePattern {
  pattern: string
  count: number
  example_ids: string[]
  suggested_fix: string
}

export interface Example {
  id: string
  input: string
  output: string
  reason: string
}

export interface WorkflowPattern {
  tools: string[]
  success_rate: number
  count: number
}

export interface SedimentationCandidate {
  id: string
  procedure_summary: string
  source_conversation_id: string
}

export interface OptimizationSuggestion {
  priority: 'high' | 'medium' | 'low'
  target: string
  suggestion: string
}

export interface Artifact {
  path: string
  kind: string
  action: 'created' | 'updated'
  size_bytes: number
}

export interface EvalSummary {
  total: number
  passed: number
  failed: number
  regressions: number
  pass_rate: number
}

export interface EvalCaseResult {
  id: string
  input_summary: string
  expected: Record<string, unknown>
  actual: Record<string, unknown>
  passed: boolean
  is_regression: boolean
  evaluators: Record<string, { passed: boolean; details: string }>
  error: string
}

export interface EvalResults {
  summary: EvalSummary
  cases: EvalCaseResult[]
  regressions: Array<{ id: string; reason: string; previous_result: string; current_result: string }>
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export async function createOptimizationRun(body: {
  skill_id: string
  data_project_id: string
  signal_sources?: Record<string, boolean>
}): Promise<OptimizationRun> {
  return http<OptimizationRun>('/api/skill-optimization/runs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function listOptimizationRuns(params?: {
  skill_id?: string
  data_project_id?: string
  status?: string
  limit?: number
  offset?: number
}): Promise<{ items: OptimizationRun[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.skill_id) qs.set('skill_id', params.skill_id)
  if (params?.data_project_id) qs.set('data_project_id', params.data_project_id)
  if (params?.status) qs.set('status', params.status)
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.offset) qs.set('offset', String(params.offset))
  const suffix = qs.toString() ? `?${qs}` : ''
  return http<{ items: OptimizationRun[]; total: number }>(`/api/skill-optimization/runs${suffix}`)
}

export async function getOptimizationRun(runId: string): Promise<OptimizationRun> {
  return http<OptimizationRun>(`/api/skill-optimization/runs/${runId}`)
}

export async function reviewOptimizationRun(
  runId: string,
  body: { action: 'approve' | 'reject'; notes?: string }
): Promise<OptimizationRun> {
  return http<OptimizationRun>(`/api/skill-optimization/runs/${runId}/review`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getRunDiagnosis(runId: string): Promise<DiagnosisResult> {
  return http<DiagnosisResult>(`/api/skill-optimization/runs/${runId}/diagnosis`)
}

export async function getRunArtifacts(runId: string): Promise<{ artifacts: Artifact[] }> {
  return http<{ artifacts: Artifact[] }>(`/api/skill-optimization/runs/${runId}/artifacts`)
}

export async function getRunDiff(runId: string): Promise<{ diff: string }> {
  return http<{ diff: string }>(`/api/skill-optimization/runs/${runId}/diff`)
}

export async function getRunEvalResults(runId: string): Promise<EvalResults> {
  return http<EvalResults>(`/api/skill-optimization/runs/${runId}/eval-results`)
}

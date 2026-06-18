/**
 * Skill Optimization store — manages optimization runs and UI state.
 */

import { create } from 'zustand'
import type {
  OptimizationRun,
  DiagnosisResult,
  Artifact,
  EvalResults,
} from '../services/backendApi/skill-optimization'
import {
  createOptimizationRun,
  listOptimizationRuns,
  getOptimizationRun,
  reviewOptimizationRun,
  getRunDiagnosis,
  getRunArtifacts,
  getRunDiff,
  getRunEvalResults,
} from '../services/backendApi/skill-optimization'

interface SkillOptimizationState {
  // Data
  runs: OptimizationRun[]
  runsTotal: number
  currentRun: OptimizationRun | null
  diagnosis: DiagnosisResult | null
  artifacts: Artifact[]
  diff: string
  evalResults: EvalResults | null

  // UI state
  loading: boolean
  error: string
  activeTab: 'runs' | 'diagnosis' | 'preview' | 'eval'

  // Actions
  setActiveTab: (tab: SkillOptimizationState['activeTab']) => void
  clearError: () => void

  // API actions
  fetchRuns: (params?: { skill_id?: string; status?: string }) => Promise<void>
  fetchRun: (runId: string) => Promise<void>
  triggerOptimization: (body: {
    skill_id: string
    data_project_id: string
    signal_sources?: Record<string, boolean>
  }) => Promise<OptimizationRun>
  reviewRun: (runId: string, action: 'approve' | 'reject', notes?: string) => Promise<void>
  fetchDiagnosis: (runId: string) => Promise<void>
  fetchArtifacts: (runId: string) => Promise<void>
  fetchDiff: (runId: string) => Promise<void>
  fetchEvalResults: (runId: string) => Promise<void>
}

export const useSkillOptimizationStore = create<SkillOptimizationState>((set, get) => ({
  // Initial state
  runs: [],
  runsTotal: 0,
  currentRun: null,
  diagnosis: null,
  artifacts: [],
  diff: '',
  evalResults: null,
  loading: false,
  error: '',
  activeTab: 'runs',

  // UI actions
  setActiveTab: (tab) => set({ activeTab: tab }),
  clearError: () => set({ error: '' }),

  // API actions
  fetchRuns: async (params) => {
    set({ loading: true, error: '' })
    try {
      const result = await listOptimizationRuns(params)
      set({ runs: result.items, runsTotal: result.total })
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },

  fetchRun: async (runId) => {
    set({ loading: true, error: '' })
    try {
      const run = await getOptimizationRun(runId)
      set({ currentRun: run })
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },

  triggerOptimization: async (body) => {
    set({ loading: true, error: '' })
    try {
      const run = await createOptimizationRun(body)
      set((s) => ({ runs: [run, ...s.runs], currentRun: run, activeTab: 'diagnosis' }))
      // Auto-fetch diagnosis and artifacts
      const runId = run.id
      get().fetchDiagnosis(runId)
      get().fetchArtifacts(runId)
      get().fetchDiff(runId)
      return run
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : String(e) })
      throw e
    } finally {
      set({ loading: false })
    }
  },

  reviewRun: async (runId, action, notes) => {
    set({ loading: true, error: '' })
    try {
      const run = await reviewOptimizationRun(runId, { action, notes })
      set((s) => ({
        currentRun: run,
        runs: s.runs.map((r) => (r.id === runId ? run : r)),
      }))
    } catch (e: unknown) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },

  fetchDiagnosis: async (runId) => {
    try {
      const data = await getRunDiagnosis(runId)
      set({ diagnosis: data })
    } catch {
      // Diagnosis may not be ready yet
    }
  },

  fetchArtifacts: async (runId) => {
    try {
      const data = await getRunArtifacts(runId)
      set({ artifacts: data.artifacts })
    } catch {
      // Artifacts may not be ready yet
    }
  },

  fetchDiff: async (runId) => {
    try {
      const data = await getRunDiff(runId)
      set({ diff: data.diff })
    } catch {
      // Diff may not be ready yet
    }
  },

  fetchEvalResults: async (runId) => {
    try {
      const data = await getRunEvalResults(runId)
      set({ evalResults: data })
    } catch {
      // Eval results may not be ready yet
    }
  },
}))

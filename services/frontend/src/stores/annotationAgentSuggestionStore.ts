import { create } from 'zustand'
import {
  annotationAgentSuggestionApi,
  type AnnotationAgentSuggestion,
  type AnnotationAgentSuggestionPatchIn,
  type AnnotationAgentSuggestionRunOut,
} from '../services/annotationAgentSuggestionApi'
import { BackendError } from '../services/backendApi'
import { showToast } from '../features/shared/toast'

export type { AnnotationAgentSuggestion } from '../services/annotationAgentSuggestionApi'

interface AnnotationAgentSuggestionState {
  suggestionsByAnnotation: Record<string, AnnotationAgentSuggestion[]>
  runningByDoc: Record<string, boolean>
  lastRunByDoc: Record<string, AnnotationAgentSuggestionRunOut>
  error: string | null

  hydrateForDoc: (docId: string) => Promise<void>
  runAutoReply: (
    docId: string,
    agentId: string,
    options?: { includeStale?: boolean },
  ) => Promise<AnnotationAgentSuggestionRunOut | null>
  updateSuggestion: (
    id: string,
    patch: AnnotationAgentSuggestionPatchIn,
  ) => Promise<AnnotationAgentSuggestion | null>
  removeSuggestion: (id: string) => Promise<boolean>
  latestForAnnotation: (annotationId: string) => AnnotationAgentSuggestion | null
}

export const useAnnotationAgentSuggestionStore = create<AnnotationAgentSuggestionState>((set, get) => ({
  suggestionsByAnnotation: {},
  runningByDoc: {},
  lastRunByDoc: {},
  error: null,

  hydrateForDoc: async (docId) => {
    try {
      const rows = await annotationAgentSuggestionApi.listByDoc(docId)
      set((state) => ({
        suggestionsByAnnotation: replaceDocSuggestions(state.suggestionsByAnnotation, docId, rows),
        error: null,
      }))
    } catch (err) {
      console.warn('[annotationAgentSuggestionStore] hydrateForDoc failed', err)
      if (err instanceof BackendError && (err.status === 400 || err.status === 404)) return
      set({ error: errMsg(err) })
    }
  },

  runAutoReply: async (docId, agentId, options = {}) => {
    if (!docId || !agentId) return null
    set((state) => ({
      runningByDoc: { ...state.runningByDoc, [docId]: true },
      error: null,
    }))
    try {
      const result = await annotationAgentSuggestionApi.run({
        doc_id: docId,
        agent_id: agentId,
        include_stale: options.includeStale ?? true,
        scope: 'current_doc',
      })
      set((state) => ({
        suggestionsByAnnotation: mergeSuggestions(state.suggestionsByAnnotation, result.suggestions),
        lastRunByDoc: { ...state.lastRunByDoc, [docId]: result },
        runningByDoc: { ...state.runningByDoc, [docId]: false },
        error: null,
      }))
      return result
    } catch (err) {
      set((state) => ({
        runningByDoc: { ...state.runningByDoc, [docId]: false },
        error: errMsg(err),
      }))
      showToast(`自动回复批注失败：${errMsg(err)}`, { level: 'error' })
      return null
    }
  },

  updateSuggestion: async (id, patch) => {
    try {
      const row = await annotationAgentSuggestionApi.update(id, patch)
      set((state) => ({
        suggestionsByAnnotation: mergeSuggestions(state.suggestionsByAnnotation, [row]),
        error: null,
      }))
      return row
    } catch (err) {
      set({ error: errMsg(err) })
      showToast(`未能更新 Agent 建议：${errMsg(err)}`, { level: 'error' })
      return null
    }
  },

  removeSuggestion: async (id) => {
    try {
      await annotationAgentSuggestionApi.remove(id)
      set((state) => ({ suggestionsByAnnotation: removeSuggestionById(state.suggestionsByAnnotation, id) }))
      return true
    } catch (err) {
      set({ error: errMsg(err) })
      showToast(`未能删除 Agent 建议：${errMsg(err)}`, { level: 'error' })
      return false
    }
  },

  latestForAnnotation: (annotationId) => {
    return latestSuggestion(get().suggestionsByAnnotation[annotationId] ?? [])
  },
}))

export function latestSuggestion(rows: AnnotationAgentSuggestion[]): AnnotationAgentSuggestion | null {
  if (rows.length === 0) return null
  return [...rows].sort((a, b) => {
    const aTime = Date.parse(a.updated_at || a.created_at || '')
    const bTime = Date.parse(b.updated_at || b.created_at || '')
    return bTime - aTime
  })[0] ?? null
}

function replaceDocSuggestions(
  current: Record<string, AnnotationAgentSuggestion[]>,
  docId: string,
  rows: AnnotationAgentSuggestion[],
): Record<string, AnnotationAgentSuggestion[]> {
  const next: Record<string, AnnotationAgentSuggestion[]> = {}
  for (const [annotationId, list] of Object.entries(current)) {
    const kept = list.filter((item) => item.doc_id !== docId)
    if (kept.length > 0) next[annotationId] = kept
  }
  return mergeSuggestions(next, rows)
}

function mergeSuggestions(
  current: Record<string, AnnotationAgentSuggestion[]>,
  rows: AnnotationAgentSuggestion[],
): Record<string, AnnotationAgentSuggestion[]> {
  if (rows.length === 0) return current
  const next: Record<string, AnnotationAgentSuggestion[]> = { ...current }
  for (const row of rows) {
    const list = next[row.annotation_id] ?? []
    const replaced = list.filter((item) => item.id !== row.id)
    next[row.annotation_id] = [...replaced, row]
  }
  return next
}

function removeSuggestionById(
  current: Record<string, AnnotationAgentSuggestion[]>,
  id: string,
): Record<string, AnnotationAgentSuggestion[]> {
  const next: Record<string, AnnotationAgentSuggestion[]> = {}
  for (const [annotationId, list] of Object.entries(current)) {
    const kept = list.filter((item) => item.id !== id)
    if (kept.length > 0) next[annotationId] = kept
  }
  return next
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

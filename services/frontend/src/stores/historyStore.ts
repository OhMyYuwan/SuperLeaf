/**
 * historyStore — Zustand state for the V3 history surface.
 *
 * Keyed by docId so multiple open documents can have independent loading
 * state; `currentDocId` tracks the one HistoryTab is currently showing.
 *
 * Diff payloads are cached by `${from}->${to}` so reopening a comparison
 * doesn't re-fetch every time. `to` can be a version number or `current`.
 */

import { create } from 'zustand'
import type { BackendDoc } from '../services/filesystemApi'
import { operationApi, type Operation } from '../services/operationApi'
import { versionApi, type DiffPayload, type VersionMeta } from '../services/versionApi'

interface HistoryState {
  currentDocId: string | null
  versions: Record<string, VersionMeta[]>
  loading: Record<string, boolean>
  error: Record<string, string | null>

  // Cached diff payloads keyed `${docId}|${from}->${to}`.
  diffs: Record<string, DiffPayload>
  diffLoading: Record<string, boolean>
  diffError: Record<string, string | null>

  // Operation audit log, keyed by docId. Last 50 by default, newest first.
  operations: Record<string, Operation[]>
  opsLoading: Record<string, boolean>
  opsError: Record<string, string | null>

  setCurrentDoc: (docId: string | null) => void
  loadVersions: (docId: string) => Promise<void>
  loadDiff: (docId: string, from: number, to: number | 'current') => Promise<DiffPayload>
  restore: (docId: string, version: number) => Promise<BackendDoc>
  addLabel: (docId: string, version: number, text: string) => Promise<void>
  removeLabel: (docId: string, version: number, labelId: string) => Promise<void>
  loadOperations: (docId: string) => Promise<void>
}

function diffKey(docId: string, from: number, to: number | 'current') {
  return `${docId}|${from}->${to}`
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  currentDocId: null,
  versions: {},
  loading: {},
  error: {},
  diffs: {},
  diffLoading: {},
  diffError: {},
  operations: {},
  opsLoading: {},
  opsError: {},

  setCurrentDoc: (docId) => set({ currentDocId: docId }),

  loadVersions: async (docId) => {
    set((s) => ({
      loading: { ...s.loading, [docId]: true },
      error: { ...s.error, [docId]: null },
    }))
    try {
      const versions = await versionApi.list(docId)
      set((s) => ({
        versions: { ...s.versions, [docId]: versions },
        loading: { ...s.loading, [docId]: false },
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载版本列表失败'
      set((s) => ({
        loading: { ...s.loading, [docId]: false },
        error: { ...s.error, [docId]: msg },
      }))
    }
  },

  loadDiff: async (docId, from, to) => {
    const key = diffKey(docId, from, to)
    const cached = get().diffs[key]
    if (cached) return cached
    set((s) => ({
      diffLoading: { ...s.diffLoading, [key]: true },
      diffError: { ...s.diffError, [key]: null },
    }))
    try {
      const resp = await versionApi.diff(docId, from, to)
      set((s) => ({
        diffs: { ...s.diffs, [key]: resp.diff },
        diffLoading: { ...s.diffLoading, [key]: false },
      }))
      return resp.diff
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载 diff 失败'
      set((s) => ({
        diffLoading: { ...s.diffLoading, [key]: false },
        diffError: { ...s.diffError, [key]: msg },
      }))
      throw err
    }
  },

  restore: async (docId, version) => {
    const doc = await versionApi.restore(docId, version)
    // Restore creates a new snapshot; refresh the list so it shows up.
    await get().loadVersions(docId)
    return doc
  },

  addLabel: async (docId, version, text) => {
    const label = await versionApi.addLabel(docId, version, text)
    set((s) => {
      const list = s.versions[docId] ?? []
      const next = list.map((v) =>
        v.version === version ? { ...v, labels: [...v.labels, label] } : v,
      )
      return { versions: { ...s.versions, [docId]: next } }
    })
  },

  removeLabel: async (docId, version, labelId) => {
    await versionApi.removeLabel(docId, labelId)
    set((s) => {
      const list = s.versions[docId] ?? []
      const next = list.map((v) =>
        v.version === version
          ? { ...v, labels: v.labels.filter((l) => l.id !== labelId) }
          : v,
      )
      return { versions: { ...s.versions, [docId]: next } }
    })
  },

  loadOperations: async (docId) => {
    set((s) => ({
      opsLoading: { ...s.opsLoading, [docId]: true },
      opsError: { ...s.opsError, [docId]: null },
    }))
    try {
      const rows = await operationApi.list(docId, { limit: 50 })
      set((s) => ({
        operations: { ...s.operations, [docId]: rows },
        opsLoading: { ...s.opsLoading, [docId]: false },
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载操作日志失败'
      set((s) => ({
        opsLoading: { ...s.opsLoading, [docId]: false },
        opsError: { ...s.opsError, [docId]: msg },
      }))
    }
  },
}))

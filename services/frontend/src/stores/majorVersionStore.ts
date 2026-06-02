/**
 * majorVersionStore — Zustand state for project-level major version (git commit) history.
 *
 * Keyed by projectId. Diff payloads are cached by `${projectId}|${sha}|${against ?? 'current'}`
 * so re-opening the same diff doesn't re-fetch.
 */

import { create } from 'zustand'
import {
  majorVersionApi,
  type CommitDiff,
  type CommitMeta,
  type MajorVersionSnapshot,
} from '../services/majorVersionApi'

interface MajorVersionState {
  commits: Record<string, CommitMeta[]>
  loading: Record<string, boolean>
  error: Record<string, string | null>

  // Cached diffs keyed `${projectId}|${sha}|${against ?? 'current'}`.
  diffs: Record<string, CommitDiff>
  diffLoading: Record<string, boolean>
  diffError: Record<string, string | null>

  loadCommits: (projectId: string, limit?: number) => Promise<void>
  createCommit: (projectId: string, message: string) => Promise<MajorVersionSnapshot>
  loadDiff: (projectId: string, sha: string, against?: string) => Promise<CommitDiff>
  restore: (projectId: string, sha: string, message?: string) => Promise<MajorVersionSnapshot>
}

function diffKey(projectId: string, sha: string, against?: string) {
  return `${projectId}|${sha}|${against ?? 'current'}`
}

export const useMajorVersionStore = create<MajorVersionState>((set, get) => ({
  commits: {},
  loading: {},
  error: {},
  diffs: {},
  diffLoading: {},
  diffError: {},

  loadCommits: async (projectId, limit = 50) => {
    set((s) => ({
      loading: { ...s.loading, [projectId]: true },
      error: { ...s.error, [projectId]: null },
    }))
    try {
      const commits = await majorVersionApi.list(projectId, limit)
      set((s) => ({
        commits: { ...s.commits, [projectId]: commits },
        loading: { ...s.loading, [projectId]: false },
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载大版本失败'
      set((s) => ({
        loading: { ...s.loading, [projectId]: false },
        error: { ...s.error, [projectId]: msg },
      }))
    }
  },

  createCommit: async (projectId, message) => {
    const snapshot = await majorVersionApi.create(projectId, message)
    // Refresh commits list so the new one shows up at the top.
    await get().loadCommits(projectId)
    return snapshot
  },

  loadDiff: async (projectId, sha, against) => {
    const key = diffKey(projectId, sha, against)
    const cached = get().diffs[key]
    if (cached) return cached
    set((s) => ({
      diffLoading: { ...s.diffLoading, [key]: true },
      diffError: { ...s.diffError, [key]: null },
    }))
    try {
      const diff = await majorVersionApi.diff(projectId, sha, against)
      set((s) => ({
        diffs: { ...s.diffs, [key]: diff },
        diffLoading: { ...s.diffLoading, [key]: false },
      }))
      return diff
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载 diff 失败'
      set((s) => ({
        diffLoading: { ...s.diffLoading, [key]: false },
        diffError: { ...s.diffError, [key]: msg },
      }))
      throw err
    }
  },

  restore: async (projectId, sha, message) => {
    const snapshot = await majorVersionApi.restore(projectId, sha, message)
    // Refresh commits so the new restore commit shows up.
    await get().loadCommits(projectId)
    return snapshot
  },
}))

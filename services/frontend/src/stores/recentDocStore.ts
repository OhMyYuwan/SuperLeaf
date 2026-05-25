/**
 * recentDocStore — remembers the last active document per project.
 *
 * Why a separate store: documentStore.activeDocumentId is global (single value)
 * and gets cleared by resetProjectScopedStores() on every project switch, so
 * re-entering a project lands on a blank editor. This store survives project
 * resets (it's user-scoped, not project-scoped) and keys recall by projectId
 * so each project remembers its own last open doc.
 *
 * Frontend-only / device-local: per-device behavior is fine for "auto-open the
 * doc I had open last time on this machine". A backend-synced version could
 * track project.last_active_doc per (user, project) but isn't needed yet.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createUserScopedStorage } from './_userScopedStorage'

interface RecentDocState {
  byProject: Record<string, string>
  record: (projectId: string, docId: string) => void
  forget: (projectId: string) => void
  get: (projectId: string) => string | null
}

export const useRecentDocStore = create<RecentDocState>()(
  persist(
    (set, getState) => ({
      byProject: {},
      record: (projectId, docId) => {
        if (!projectId || !docId) return
        if (getState().byProject[projectId] === docId) return
        set((s) => ({ byProject: { ...s.byProject, [projectId]: docId } }))
      },
      forget: (projectId) => {
        set((s) => {
          if (!(projectId in s.byProject)) return s
          const { [projectId]: _drop, ...rest } = s.byProject
          return { byProject: rest }
        })
      },
      get: (projectId) => getState().byProject[projectId] ?? null,
    }),
    {
      name: 'yuwan-recent-docs-v1',
      storage: createUserScopedStorage(),
    },
  ),
)

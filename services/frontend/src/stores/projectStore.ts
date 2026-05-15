/**
 * projectStore — current project + project list state.
 *
 * Owns `currentProjectId` which `backendApi` reads via the registered reader
 * to inject the `X-Project-Id` header on every project-scoped request. Owns
 * `viewMode` for the project-list page (table | grid), persisted to
 * localStorage so the user's preference survives reloads.
 *
 * The reader is registered at module load (side effect of `import`) so any
 * subsequent `http(...)` call from anywhere in the app sees the current id.
 */

import { create } from 'zustand'
import { projectsApi, type GitHubProjectImport, type ProjectSummary } from '../services/projectsApi'
import { registerProjectIdReader } from '../services/backendApi'

const VIEW_MODE_KEY = 'yuwanlab.projectListViewMode'

function readInitialViewMode(): 'table' | 'grid' {
  if (typeof window === 'undefined') return 'grid'
  const raw = window.localStorage.getItem(VIEW_MODE_KEY)
  return raw === 'table' ? 'table' : 'grid'
}

interface ProjectState {
  projects: ProjectSummary[]
  currentProjectId: string | null
  currentProjectRole: 'owner' | 'editor' | 'viewer' | null
  viewMode: 'table' | 'grid'
  loading: boolean
  loaded: boolean
  error: string | null

  load: () => Promise<void>
  setCurrent: (id: string | null) => void
  create: (name: string) => Promise<ProjectSummary>
  importGithub: (body: GitHubProjectImport) => Promise<ProjectSummary>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
  setViewMode: (mode: 'table' | 'grid') => void
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProjectId: null,
  currentProjectRole: null,
  viewMode: readInitialViewMode(),
  loading: false,
  loaded: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const projects = await projectsApi.list()
      const currentProjectId = get().currentProjectId
      const current = currentProjectId
        ? projects.find((project) => project.id === currentProjectId)
        : null
      set({
        projects,
        currentProjectRole: currentProjectId ? current?.my_role ?? null : null,
        loading: false,
        loaded: true,
      })
    } catch (e) {
      set({
        loading: false,
        loaded: true,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  },

  setCurrent: (id) => {
    if (get().currentProjectId === id) return
    const project = get().projects.find((p) => p.id === id)
    set({ currentProjectId: id, currentProjectRole: project?.my_role ?? null })
  },

  create: async (name) => {
    const created = await projectsApi.create({ name })
    set((s) => ({ projects: [created, ...s.projects] }))
    return created
  },

  importGithub: async (body) => {
    const created = await projectsApi.importGithub(body)
    set((s) => ({ projects: [created, ...s.projects] }))
    return created
  },

  rename: async (id, name) => {
    const updated = await projectsApi.update(id, { name })
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? updated : p)),
    }))
  },

  remove: async (id) => {
    await projectsApi.remove(id)
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      currentProjectId: s.currentProjectId === id ? null : s.currentProjectId,
    }))
  },

  setViewMode: (mode) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VIEW_MODE_KEY, mode)
    }
    set({ viewMode: mode })
  },
}))

registerProjectIdReader(() => useProjectStore.getState().currentProjectId)

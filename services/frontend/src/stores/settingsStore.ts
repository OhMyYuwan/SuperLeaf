/**
 * settingsStore — provider registry mirrored to frontend state.
 *
 * Keeps the canonical list in SQLite (backend) but caches here so UI reacts
 * synchronously. Every mutation hits the backend and rehydrates on success.
 */

import { create } from 'zustand'
import { providerApi, type Provider, type ProviderDraft, type ProviderUpdate } from '../services/backendApi'
import {
  DEFAULT_LATEX_EDITOR_THEME_ID,
  isLatexEditorThemeId,
  type LatexEditorThemeId,
} from '../features/latex-editor/theme'

const PROJECT_LIST_GROUPING_KEY = 'yuwanlab.projectListGrouping'
const LATEX_EDITOR_THEME_KEY = 'yuwanlab.latexEditorTheme'
const MATH_PREVIEW_KEY = 'yuwanlab.mathPreview'
const LATEX_PDF_VIEWER_KEY = 'yuwanlab.latexPdfViewer'

export type ProjectListGrouping = 'grouped' | 'mixed'
export type LatexPdfViewerPreference = 'react-pdf' | 'pdfjs-viewer'

function readInitialProjectListGrouping(): ProjectListGrouping {
  if (typeof window === 'undefined') return 'grouped'
  return window.localStorage.getItem(PROJECT_LIST_GROUPING_KEY) === 'mixed' ? 'mixed' : 'grouped'
}

function readInitialLatexEditorTheme(): LatexEditorThemeId {
  if (typeof window === 'undefined') return DEFAULT_LATEX_EDITOR_THEME_ID
  const stored = window.localStorage.getItem(LATEX_EDITOR_THEME_KEY)
  return isLatexEditorThemeId(stored) ? stored : DEFAULT_LATEX_EDITOR_THEME_ID
}

function readInitialMathPreview(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(MATH_PREVIEW_KEY) === 'true'
}

function readInitialLatexPdfViewer(): LatexPdfViewerPreference {
  if (typeof window === 'undefined') return 'react-pdf'
  return window.localStorage.getItem(LATEX_PDF_VIEWER_KEY) === 'pdfjs-viewer'
    ? 'pdfjs-viewer'
    : 'react-pdf'
}

interface SettingsState {
  providers: Provider[]
  projectListGrouping: ProjectListGrouping
  latexEditorTheme: LatexEditorThemeId
  mathPreview: boolean
  latexPdfViewer: LatexPdfViewerPreference
  loading: boolean
  loaded: boolean
  error: string | null
  backendReachable: boolean | null

  load: () => Promise<void>
  create: (draft: ProviderDraft) => Promise<Provider | null>
  update: (id: string, patch: ProviderUpdate) => Promise<Provider | null>
  remove: (id: string) => Promise<boolean>
  activate: (id: string) => Promise<Provider | null>
  probe: (id: string) => Promise<Provider | null>
  getActive: () => Provider | null
  setProjectListGrouping: (grouping: ProjectListGrouping) => void
  setLatexEditorTheme: (theme: LatexEditorThemeId) => void
  setMathPreview: (enabled: boolean) => void
  setLatexPdfViewer: (viewer: LatexPdfViewerPreference) => void
  reset: () => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  providers: [],
  projectListGrouping: readInitialProjectListGrouping(),
  latexEditorTheme: readInitialLatexEditorTheme(),
  mathPreview: readInitialMathPreview(),
  latexPdfViewer: readInitialLatexPdfViewer(),
  loading: false,
  loaded: false,
  error: null,
  backendReachable: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const providers = await providerApi.list()
      set({ providers, loading: false, loaded: true, backendReachable: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ loading: false, loaded: true, error: msg, backendReachable: false })
    }
  },

  create: async (draft) => {
    try {
      const created = await providerApi.create(draft)
      set((s) => ({ providers: mergeById(s.providers, created) }))
      if (created.is_active) {
        set((s) => ({ providers: applyActive(s.providers, created.id) }))
      }
      return created
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  update: async (id, patch) => {
    try {
      const updated = await providerApi.update(id, patch)
      set((s) => ({ providers: mergeById(s.providers, updated) }))
      return updated
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  remove: async (id) => {
    try {
      await providerApi.remove(id)
      set((s) => ({ providers: s.providers.filter((p) => p.id !== id) }))
      return true
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return false
    }
  },

  activate: async (id) => {
    try {
      const updated = await providerApi.activate(id)
      set((s) => ({ providers: applyActive(mergeById(s.providers, updated), id) }))
      return updated
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  probe: async (id) => {
    try {
      const updated = await providerApi.probe(id)
      set((s) => ({ providers: mergeById(s.providers, updated) }))
      return updated
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },

  getActive: () => get().providers.find((p) => p.is_active) ?? null,

  setProjectListGrouping: (grouping) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PROJECT_LIST_GROUPING_KEY, grouping)
    }
    set({ projectListGrouping: grouping })
  },

  setLatexEditorTheme: (theme) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LATEX_EDITOR_THEME_KEY, theme)
    }
    set({ latexEditorTheme: theme })
  },

  setMathPreview: (enabled) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MATH_PREVIEW_KEY, enabled ? 'true' : 'false')
    }
    set({ mathPreview: enabled })
  },

  setLatexPdfViewer: (viewer) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LATEX_PDF_VIEWER_KEY, viewer)
    }
    set({ latexPdfViewer: viewer })
  },

  reset: () => set({ providers: [], loaded: false, error: null }),
}))

function mergeById(providers: Provider[], next: Provider): Provider[] {
  const idx = providers.findIndex((p) => p.id === next.id)
  if (idx === -1) return [...providers, next]
  const copy = providers.slice()
  copy[idx] = next
  return copy
}

function applyActive(providers: Provider[], activeId: string): Provider[] {
  return providers.map((p) => ({ ...p, is_active: p.id === activeId }))
}

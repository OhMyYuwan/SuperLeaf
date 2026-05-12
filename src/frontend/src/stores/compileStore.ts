/**
 * compileStore — state for LaTeX compilation.
 *
 * Tracks:
 *   - Available compilers (detected once on mount)
 *   - Project compile settings (main doc, chosen compiler)
 *   - Latest compile result (ok/error/log/pdf bytes)
 *   - Compiling flag
 *   - pdfVersion — bumped each successful compile so the preview refreshes
 *   - Auto-compile preference (local-only, persisted in localStorage)
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  compileApi,
  type CompileResult,
  type CompileSettings,
  type CompilerInfo,
} from '../services/backendApi'

interface CompileState {
  compilers: CompilerInfo | null
  settings: CompileSettings | null
  lastResult: CompileResult | null
  compiling: boolean
  pdfVersion: number
  autoCompile: boolean
  fullLog: string | null
  loadError: string | null

  loadCompilers: () => Promise<void>
  rescanCompilers: () => Promise<void>
  loadSettings: () => Promise<void>
  updateSettings: (patch: Partial<CompileSettings>) => Promise<void>
  compile: (mainDocId?: string | null) => Promise<void>
  loadFullLog: () => Promise<void>
  setAutoCompile: (enabled: boolean) => void
}

export const useCompileStore = create<CompileState>()(
  persist(
    (set, get) => ({
      compilers: null,
      settings: null,
      lastResult: null,
      compiling: false,
      pdfVersion: 0,
      autoCompile: false,
      fullLog: null,
      loadError: null,

      loadCompilers: async () => {
        try {
          const info = await compileApi.listCompilers()
          set({ compilers: info, loadError: null })
        } catch (e) {
          set({ loadError: e instanceof Error ? e.message : String(e) })
        }
      },

      rescanCompilers: async () => {
        try {
          const info = await compileApi.rescanCompilers()
          set({ compilers: info, loadError: null })
        } catch (e) {
          set({ loadError: e instanceof Error ? e.message : String(e) })
        }
      },

      loadSettings: async () => {
        try {
          const settings = await compileApi.getSettings()
          set({ settings })
        } catch (e) {
          set({ loadError: e instanceof Error ? e.message : String(e) })
        }
      },

      updateSettings: async (patch) => {
        try {
          const settings = await compileApi.updateSettings(patch)
          set({ settings })
        } catch (e) {
          set({ loadError: e instanceof Error ? e.message : String(e) })
        }
      },

      compile: async (mainDocId) => {
        if (get().compiling) return
        set({ compiling: true, loadError: null })
        try {
          const settings = get().settings
          const result = await compileApi.compile({
            compiler: settings?.compiler || undefined,
            main_doc_id: mainDocId || settings?.main_doc_id || undefined,
          })
          set((s) => ({
            lastResult: result,
            compiling: false,
            pdfVersion: result.ok ? s.pdfVersion + 1 : s.pdfVersion,
            fullLog: null,
          }))
        } catch (e) {
          set({
            compiling: false,
            loadError: e instanceof Error ? e.message : String(e),
          })
        }
      },

      loadFullLog: async () => {
        try {
          const log = await compileApi.getLog()
          set({ fullLog: log })
        } catch (e) {
          set({ loadError: e instanceof Error ? e.message : String(e) })
        }
      },

      setAutoCompile: (enabled) => set({ autoCompile: enabled }),
    }),
    {
      name: 'yuwan-compile-v1',
      partialize: (s) => ({ autoCompile: s.autoCompile }),
    },
  ),
)

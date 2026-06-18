/**
 * compileStore — state for LaTeX compilation.
 *
 * Tracks:
 *   - Available compilers (detected once on mount)
 *   - Project compile settings (main doc, chosen compiler, incremental)
 *   - Latest compile result (ok/error/log/pdf bytes/build id)
 *   - Compiling flag
 *   - pdfVersion — bumped each successful compile so the preview refreshes
 *   - activeBuildId — identity of the latest successful build
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
  activeBuildId: string
  autoCompile: boolean
  fullLog: string | null
  loadError: string | null
  compileRequestSeq: number

  loadCompilers: () => Promise<void>
  rescanCompilers: () => Promise<void>
  loadSettings: () => Promise<void>
  updateSettings: (patch: Partial<CompileSettings>) => Promise<void>
  compile: (
    mainDocId?: string | null,
    options?: { fromScratch?: boolean; isAutoCompile?: boolean },
  ) => Promise<void>
  clearCache: () => Promise<void>
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
      activeBuildId: '',
      autoCompile: false,
      fullLog: null,
      loadError: null,
      compileRequestSeq: 0,

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

      compile: async (mainDocId, options = {}) => {
        if (get().compiling) return
        const requestSeq = get().compileRequestSeq + 1
        set({ compiling: true, loadError: null, compileRequestSeq: requestSeq })
        try {
          const settings = get().settings
          const result = await compileApi.compile({
            compiler: settings?.compiler || undefined,
            main_doc_id: mainDocId || settings?.main_doc_id || undefined,
            incremental_compile: settings?.incremental_compile,
            from_scratch: options.fromScratch ?? false,
            is_auto_compile: options.isAutoCompile ?? false,
          })
          // Guard: discard stale responses from earlier requests.
          if (get().compileRequestSeq !== requestSeq) return
          set((s) => ({
            lastResult: result,
            compiling: false,
            activeBuildId: result.ok ? result.build_id : s.activeBuildId,
            pdfVersion: result.ok ? s.pdfVersion + 1 : s.pdfVersion,
            fullLog: null,
          }))
        } catch (e) {
          if (get().compileRequestSeq !== requestSeq) return
          set({
            compiling: false,
            loadError: e instanceof Error ? e.message : String(e),
          })
        }
      },

      clearCache: async () => {
        try {
          await compileApi.clearCache()
          set({ activeBuildId: '', pdfVersion: 0, lastResult: null, fullLog: null })
        } catch (e) {
          set({ loadError: e instanceof Error ? e.message : String(e) })
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

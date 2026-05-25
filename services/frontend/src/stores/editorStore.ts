/**
 * editorStore — Layer 1 状态管理。
 *
 * 持有每个文档独立的 EditorState（选区、光标、可见区域）。当选区变化时
 * 通过 selectionContext 派生完整的 Selection（含上下文），供 Agent 消费。
 *
 * Persisted (user-scoped): only the lightweight position fields per doc —
 * cursor / selectionRange / viewport. The heavy `selection` object (with
 * full-document context) is recomputed on demand and never written to disk.
 * This is what lets the editor restore the cursor + scroll position when
 * the user re-enters a project or reloads the page.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { EditorState, Selection } from '../types/editor'
import { extractSelection } from '../services/selectionContext'
import { useDocumentStore } from './documentStore'
import { createUserScopedStorage } from './_userScopedStorage'

interface EditorStoreState {
  states: Record<string, EditorState>

  updateSelection: (
    documentId: string,
    range: { from: number; to: number },
  ) => Selection | null
  updateViewState: (
    documentId: string,
    viewState: {
      cursor: number
      selectionRange: { from: number; to: number }
      viewport: { from: number; to: number; firstVisibleLine?: number }
    },
  ) => void
  clearSelection: (documentId: string) => void
  getSelection: (documentId: string) => Selection | null
}

export const useEditorStore = create<EditorStoreState>()(
  persist(
    (set, get) => ({
      states: {},

      updateSelection: (documentId, range) => {
        const doc = useDocumentStore.getState().documents[documentId]
        if (!doc) return null
        const selectionRange = clampRange(range, doc.content.length)

        const selection = selectionRange.from === selectionRange.to
          ? null
          : extractSelection(doc, selectionRange)

        set((state) => {
          const prev = state.states[documentId]
          const next: EditorState = {
            documentId,
            selection,
            selectionRange,
            cursor: selectionRange.to,
            viewport: prev?.viewport ?? { from: 0, to: doc.content.length },
            focusedParagraphId: selection?.paragraphIds[0] ?? prev?.focusedParagraphId,
          }
          return { states: { ...state.states, [documentId]: next } }
        })

        return selection
      },

      updateViewState: (documentId, viewState) => {
        const doc = useDocumentStore.getState().documents[documentId]
        if (!doc) return
        const selectionRange = clampRange(viewState.selectionRange, doc.content.length)

        set((state) => {
          const prev = state.states[documentId]
          const sameSelectionRange =
            prev?.selectionRange.from === selectionRange.from &&
            prev.selectionRange.to === selectionRange.to
          let selection: Selection | null = null
          if (sameSelectionRange) {
            selection = prev.selection
          } else if (selectionRange.from !== selectionRange.to) {
            selection = extractSelection(doc, selectionRange)
          }
          const next: EditorState = {
            documentId,
            selection,
            selectionRange,
            cursor: Math.max(0, Math.min(viewState.cursor, doc.content.length)),
            viewport: viewState.viewport,
            focusedParagraphId: selection?.paragraphIds[0] ?? prev?.focusedParagraphId,
          }
          return { states: { ...state.states, [documentId]: next } }
        })
      },

      clearSelection: (documentId) => {
        set((state) => {
          const prev = state.states[documentId]
          if (!prev) return state
          return {
            states: {
              ...state.states,
              [documentId]: {
                ...prev,
                selection: null,
                selectionRange: { from: prev.cursor, to: prev.cursor },
              },
            },
          }
        })
      },

      getSelection: (documentId) => {
        return get().states[documentId]?.selection ?? null
      },
    }),
    {
      name: 'yuwan-editor-v1',
      storage: createUserScopedStorage(),
      partialize: (state) => {
        const minimal: Record<string, Pick<EditorState, 'documentId' | 'cursor' | 'selectionRange' | 'viewport'>> = {}
        for (const [id, s] of Object.entries(state.states)) {
          minimal[id] = {
            documentId: s.documentId,
            cursor: s.cursor,
            selectionRange: s.selectionRange,
            viewport: s.viewport,
          }
        }
        return { states: minimal }
      },
    },
  ),
)

function clampRange(range: { from: number; to: number }, docLength: number) {
  const from = Math.max(0, Math.min(range.from, docLength))
  const to = Math.max(0, Math.min(range.to, docLength))
  return from <= to ? { from, to } : { from: to, to: from }
}

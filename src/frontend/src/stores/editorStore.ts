/**
 * editorStore — Layer 1 状态管理。
 *
 * 持有每个文档独立的 EditorState（选区、光标、可见区域）。当选区变化时
 * 通过 selectionContext 派生完整的 Selection（含上下文），供 Agent 消费。
 */

import { create } from 'zustand'
import type { EditorState, Selection } from '../types/editor'
import { extractSelection } from '../services/selectionContext'
import { useDocumentStore } from './documentStore'

interface EditorStoreState {
  states: Record<string, EditorState>

  updateSelection: (
    documentId: string,
    range: { from: number; to: number },
  ) => Selection | null
  clearSelection: (documentId: string) => void
  getSelection: (documentId: string) => Selection | null
}

export const useEditorStore = create<EditorStoreState>((set, get) => ({
  states: {},

  updateSelection: (documentId, range) => {
    const doc = useDocumentStore.getState().documents[documentId]
    if (!doc) return null

    const selection = range.from === range.to
      ? null
      : extractSelection(doc, range)

    set((state) => {
      const prev = state.states[documentId]
      const next: EditorState = {
        documentId,
        selection,
        cursor: range.to,
        viewport: prev?.viewport ?? { from: 0, to: doc.content.length },
        focusedParagraphId: selection?.paragraphIds[0] ?? prev?.focusedParagraphId,
      }
      return { states: { ...state.states, [documentId]: next } }
    })

    return selection
  },

  clearSelection: (documentId) => {
    set((state) => {
      const prev = state.states[documentId]
      if (!prev) return state
      return {
        states: {
          ...state.states,
          [documentId]: { ...prev, selection: null },
        },
      }
    })
  },

  getSelection: (documentId) => {
    return get().states[documentId]?.selection ?? null
  },
}))

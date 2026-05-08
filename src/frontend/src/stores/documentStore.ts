/**
 * documentStore — Layer 0 状态管理。
 *
 * 持有所有已打开文档，哪一份是当前激活的，并在每次内容变更时
 * 重新解析 structure（大纲从这里派生）。
 *
 * V1 阶段用内存存储；W10 起接入后端 /api/documents 时再换 backing store。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Document, DocumentFormat } from '../types/document'
import { createDocument, parseDocument } from '../services/documentParser'

interface DocumentSeed {
  id: string
  name: string
  format: DocumentFormat
  content: string
}

interface DocumentState {
  documents: Record<string, Document>
  activeDocumentId: string | null

  setActive: (id: string) => void
  getActive: () => Document | null
  updateContent: (id: string, content: string) => void
  seed: (seeds: DocumentSeed[]) => void
}

export const useDocumentStore = create<DocumentState>()(
  persist(
    (set, get) => ({
      documents: {},
      activeDocumentId: null,

      setActive: (id) => {
        if (get().documents[id]) {
          set({ activeDocumentId: id })
        }
      },

      getActive: () => {
        const { activeDocumentId, documents } = get()
        return activeDocumentId ? documents[activeDocumentId] ?? null : null
      },

      updateContent: (id, content) => {
        set((state) => {
          const existing = state.documents[id]
          if (!existing) return state
          const next: Document = {
            ...existing,
            content,
            structure: parseDocument(content, existing.format),
            version: existing.version + 1,
            metadata: { ...existing.metadata, modified: new Date() },
          }
          return { documents: { ...state.documents, [id]: next } }
        })
      },

      seed: (seeds) => {
        const docs: Record<string, Document> = {}
        for (const s of seeds) {
          docs[s.id] = createDocument({
            id: s.id,
            name: s.name,
            content: s.content,
            format: s.format,
          })
        }
        set({
          documents: docs,
          activeDocumentId: seeds[0]?.id ?? null,
        })
      },
    }),
    {
      name: 'yuwan-documents-v1',
    },
  ),
)

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
import { filesystemApi, type BackendDoc } from '../services/filesystemApi'

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

  // A2: backend-backed file management
  upsertFromBackendDoc: (doc: BackendDoc) => void
  loadBackendDoc: (id: string) => Promise<void>
  saveBackendDoc: (id: string) => Promise<void>
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

      upsertFromBackendDoc: (doc) => {
        const normalized = fromBackendDoc(doc)
        set((state) => ({
          documents: { ...state.documents, [normalized.id]: normalized },
        }))
      },

      loadBackendDoc: async (id) => {
        const doc = await filesystemApi.getDoc(id)
        get().upsertFromBackendDoc(doc)
        set({ activeDocumentId: id })
      },

      saveBackendDoc: async (id) => {
        const existing = get().documents[id]
        if (!existing) return
        const saved = await filesystemApi.updateDoc(id, existing.content)
        get().upsertFromBackendDoc(saved)
      },
    }),
    {
      name: 'yuwan-documents-v1',
    },
  ),
)

function fromBackendDoc(doc: BackendDoc): Document {
  const format = doc.format as DocumentFormat
  const now = new Date(doc.updated_at)
  return {
    id: doc.id,
    format,
    content: doc.content,
    structure: parseDocument(doc.content, format),
    metadata: {
      title: doc.name,
      author: 'user',
      created: now,
      modified: now,
      tags: [],
    },
    version: doc.version,
  }
}

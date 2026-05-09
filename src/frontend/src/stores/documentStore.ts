/**
 * documentStore — Layer 0 状态管理。
 *
 * 持有所有已打开文档，哪一份是当前激活的，并在每次内容变更时
 * 重新解析 structure（大纲从这里派生）。
 *
 * Auto-save：每个文档维护一个 saveStatus（idle/dirty/saving/saved/error）。
 * `updateContent` 会把状态置为 dirty 并启动 debounce 定时器，
 * 到期后自动调用 saveBackendDoc。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Document, DocumentFormat } from '../types/document'
import { createDocument, parseDocument } from '../services/documentParser'
import { filesystemApi, type BackendDoc } from '../services/filesystemApi'

const AUTO_SAVE_DEBOUNCE_MS = 1500

interface DocumentSeed {
  id: string
  name: string
  format: DocumentFormat
  content: string
}

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

interface DocumentState {
  documents: Record<string, Document>
  activeDocumentId: string | null

  saveStatus: Record<string, SaveStatus>
  lastSavedAt: Record<string, number>
  saveError: Record<string, string | null>

  setActive: (id: string) => void
  getActive: () => Document | null
  updateContent: (id: string, content: string) => void
  seed: (seeds: DocumentSeed[]) => void

  // A2: backend-backed file management
  upsertFromBackendDoc: (doc: BackendDoc) => void
  loadBackendDoc: (id: string) => Promise<void>
  saveBackendDoc: (id: string) => Promise<void>
  flushPendingSave: (id: string) => Promise<void>
}

const debounceTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {}

export const useDocumentStore = create<DocumentState>()(
  persist(
    (set, get) => ({
      documents: {},
      activeDocumentId: null,
      saveStatus: {},
      lastSavedAt: {},
      saveError: {},

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
          if (existing.content === content) return state
          const next: Document = {
            ...existing,
            content,
            structure: parseDocument(content, existing.format),
            version: existing.version + 1,
            metadata: { ...existing.metadata, modified: new Date() },
          }
          return {
            documents: { ...state.documents, [id]: next },
            saveStatus: { ...state.saveStatus, [id]: 'dirty' },
            saveError: { ...state.saveError, [id]: null },
          }
        })

        // Schedule debounced auto-save.
        const existingTimer = debounceTimers[id]
        if (existingTimer) clearTimeout(existingTimer)
        debounceTimers[id] = setTimeout(() => {
          debounceTimers[id] = undefined
          void get().saveBackendDoc(id)
        }, AUTO_SAVE_DEBOUNCE_MS)
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
          saveStatus: { ...state.saveStatus, [normalized.id]: 'saved' },
          lastSavedAt: { ...state.lastSavedAt, [normalized.id]: Date.now() },
          saveError: { ...state.saveError, [normalized.id]: null },
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
        // Cancel any pending debounce: we're saving now.
        const pending = debounceTimers[id]
        if (pending) {
          clearTimeout(pending)
          debounceTimers[id] = undefined
        }
        set((state) => ({
          saveStatus: { ...state.saveStatus, [id]: 'saving' },
          saveError: { ...state.saveError, [id]: null },
        }))
        try {
          const saved = await filesystemApi.updateDoc(id, existing.content)
          // Don't call upsertFromBackendDoc — it would replace the local
          // document and clobber any edits the user made while the request
          // was in flight. Just bump the bookkeeping state.
          set((state) => ({
            saveStatus: {
              ...state.saveStatus,
              [id]: state.documents[id]?.content === existing.content ? 'saved' : 'dirty',
            },
            lastSavedAt: { ...state.lastSavedAt, [id]: Date.now() },
            saveError: { ...state.saveError, [id]: null },
            documents: state.documents[id]
              ? {
                  ...state.documents,
                  [id]: { ...state.documents[id], version: saved.version },
                }
              : state.documents,
          }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'save failed'
          set((state) => ({
            saveStatus: { ...state.saveStatus, [id]: 'error' },
            saveError: { ...state.saveError, [id]: msg },
          }))
        }
      },

      flushPendingSave: async (id) => {
        const pending = debounceTimers[id]
        if (pending) {
          clearTimeout(pending)
          debounceTimers[id] = undefined
        }
        const status = get().saveStatus[id]
        if (status === 'dirty' || status === 'error') {
          await get().saveBackendDoc(id)
        }
      },
    }),
    {
      name: 'yuwan-documents-v1',
      partialize: (state) => ({
        documents: state.documents,
        activeDocumentId: state.activeDocumentId,
      }),
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

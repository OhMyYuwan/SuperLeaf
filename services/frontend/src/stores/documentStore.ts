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
import { createUserScopedStorage } from './_userScopedStorage'
import { showToast } from '../features/shared/toast'
import { useCollaborationStore } from './collaborationStore'

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
  collaborating: Record<string, boolean>
  backendVersions: Record<string, number>

  setActive: (id: string) => void
  clearActive: () => void
  removeDocument: (id: string) => void
  getActive: () => Document | null
  updateContent: (id: string, content: string) => void
  setCollaborating: (id: string, flag: boolean) => void
  seed: (seeds: DocumentSeed[]) => void

  // A2: backend-backed file management
  upsertFromBackendDoc: (doc: BackendDoc) => void
  loadBackendDoc: (id: string) => Promise<void>
  /** Re-fetch the doc from backend WITHOUT clobbering local unsaved edits.
   *  Used by visibility/focus-driven multi-device catch-up. If the doc is
   *  dirty or saving locally, this is a no-op so the user doesn't lose work. */
  refreshFromBackend: (id: string) => Promise<void>
  saveBackendDoc: (id: string) => Promise<void>
  flushPendingSave: (id: string) => Promise<void>
  applyDocFormatChange: (docId: string, format: DocumentFormat) => void
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
      collaborating: {},
      backendVersions: {},

      setActive: (id) => {
        if (get().documents[id]) {
          set({ activeDocumentId: id })
        }
      },

      clearActive: () => {
        set({ activeDocumentId: null })
      },

      removeDocument: (id) => {
        const pending = debounceTimers[id]
        if (pending) {
          clearTimeout(pending)
          debounceTimers[id] = undefined
        }
        set((state) => {
          const documents = { ...state.documents }
          const saveStatus = { ...state.saveStatus }
          const lastSavedAt = { ...state.lastSavedAt }
          const saveError = { ...state.saveError }
          const collaborating = { ...state.collaborating }
          const backendVersions = { ...state.backendVersions }
          delete documents[id]
          delete saveStatus[id]
          delete lastSavedAt[id]
          delete saveError[id]
          delete collaborating[id]
          delete backendVersions[id]
          return {
            documents,
            saveStatus,
            lastSavedAt,
            saveError,
            collaborating,
            backendVersions,
            activeDocumentId: state.activeDocumentId === id ? null : state.activeDocumentId,
          }
        })
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

        // In collaboration mode, Yjs handles persistence — skip auto-save.
        if (get().collaborating[id]) return

        // Schedule debounced auto-save.
        const existingTimer = debounceTimers[id]
        if (existingTimer) clearTimeout(existingTimer)
        debounceTimers[id] = setTimeout(() => {
          debounceTimers[id] = undefined
          void get().saveBackendDoc(id)
        }, AUTO_SAVE_DEBOUNCE_MS)
      },

      setCollaborating: (id, flag) => {
        set((state) => ({
          collaborating: { ...state.collaborating, [id]: flag },
        }))
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
        set((state) => {
          // `lastSavedAt` is used as the auto-compile trigger token. Use the
          // backend content timestamp so focus refreshes of the same document
          // do not look like fresh saves.
          const savedAt = backendUpdatedAtMs(doc, state.lastSavedAt[normalized.id] ?? 0)
          return {
            documents: { ...state.documents, [normalized.id]: normalized },
            saveStatus: { ...state.saveStatus, [normalized.id]: 'saved' },
            lastSavedAt: { ...state.lastSavedAt, [normalized.id]: savedAt },
            saveError: { ...state.saveError, [normalized.id]: null },
            backendVersions: { ...state.backendVersions, [normalized.id]: doc.version },
          }
        })
      },

      loadBackendDoc: async (id) => {
        const doc = await filesystemApi.getDoc(id)
        get().upsertFromBackendDoc(doc)
        set({ activeDocumentId: id })
      },

      refreshFromBackend: async (id) => {
        const status = get().saveStatus[id]
        // Never clobber unsaved local work. dirty = pending debounce; saving
        // = request in flight; error = last save errored and content is
        // still ahead of backend.
        if (status === 'dirty' || status === 'saving' || status === 'error') {
          return
        }
        try {
          const doc = await filesystemApi.getDoc(id)
          // Re-check after await — user may have started typing during the
          // round-trip; if so, drop this stale response.
          const after = get().saveStatus[id]
          if (after === 'dirty' || after === 'saving') return
          get().upsertFromBackendDoc(doc)
        } catch (err) {
          // Don't toast — this is a background refresh; failure is silent
          // but logged so dev tools surface it. Next focus retries.
          console.warn('[documentStore] refreshFromBackend failed', err)
        }
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
          if (get().collaborating[id]) {
            const collab = useCollaborationStore.getState()
            const collabText = collab.getCurrentText(id)
            if (collabText !== null) {
              try {
                await collab.waitUntilSynced(id)
                const saved = await filesystemApi.flushCollabDoc(id)
                get().upsertFromBackendDoc(saved)
                return
              } catch (flushErr) {
                console.warn('[documentStore] collab flush failed; saving current Yjs text via REST', flushErr)
                const saved = await filesystemApi.updateDoc(id, collabText)
                const savedAt = backendUpdatedAtMs(saved, Date.now())
                set((state) => ({
                  saveStatus: { ...state.saveStatus, [id]: 'saved' },
                  lastSavedAt: { ...state.lastSavedAt, [id]: savedAt },
                  saveError: { ...state.saveError, [id]: null },
                  backendVersions: { ...state.backendVersions, [id]: saved.version },
                  documents: state.documents[id]
                    ? {
                        ...state.documents,
                        [id]: {
                          ...state.documents[id],
                          content: collabText,
                          structure: parseDocument(collabText, state.documents[id].format),
                          version: saved.version,
                        },
                      }
                    : state.documents,
                }))
                return
              }
            }
            set((state) => ({
              collaborating: { ...state.collaborating, [id]: false },
            }))
          }
          const baseVersion = get().backendVersions[id] ?? existing.version
          const saved = await filesystemApi.updateDoc(id, existing.content, baseVersion)
          // Don't call upsertFromBackendDoc — it would replace the local
          // document and clobber any edits the user made while the request
          // was in flight. Just bump the bookkeeping state.
          const savedAt = backendUpdatedAtMs(saved, Date.now())
          set((state) => ({
            saveStatus: {
              ...state.saveStatus,
              [id]: state.documents[id]?.content === existing.content ? 'saved' : 'dirty',
            },
            lastSavedAt: { ...state.lastSavedAt, [id]: savedAt },
            saveError: { ...state.saveError, [id]: null },
            backendVersions: { ...state.backendVersions, [id]: saved.version },
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
          showToast(`文档保存失败：${msg}`, { level: 'error' })
        }
      },

      applyDocFormatChange: (docId, format) =>
        set((state) => {
          const doc = state.documents[docId]
          if (!doc || doc.format === format) return state
          return {
            documents: {
              ...state.documents,
              [docId]: {
                ...doc,
                format,
                structure: parseDocument(doc.content, format),
              },
            },
          }
        }),

      flushPendingSave: async (id) => {
        const pending = debounceTimers[id]
        if (pending) {
          clearTimeout(pending)
          debounceTimers[id] = undefined
        }
        if (get().collaborating[id]) {
          await get().saveBackendDoc(id)
          if (get().saveStatus[id] === 'error') {
            throw new Error('document save failed')
          }
          return
        }
        const status = get().saveStatus[id]
        if (status === 'dirty' || status === 'error') {
          await get().saveBackendDoc(id)
          if (get().saveStatus[id] === 'error') {
            throw new Error('document save failed')
          }
        }
      },
    }),
    {
      name: 'yuwan-documents-v1',
      storage: createUserScopedStorage(),
      // Only persist the active doc id. Document content used to be persisted
      // too, but it caused the editor to rehydrate stale text from the
      // previous session while the backend version history (which always
      // reads live) showed something newer. Servers is the source of truth
      // for content; the editor reloads from `loadBackendDoc` on mount.
      partialize: (state) => ({
        activeDocumentId: state.activeDocumentId,
      }),
    },
  ),
)

function backendUpdatedAtMs(doc: BackendDoc, fallback: number): number {
  const parsed = Date.parse(doc.updated_at)
  return Number.isFinite(parsed) ? parsed : fallback
}

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

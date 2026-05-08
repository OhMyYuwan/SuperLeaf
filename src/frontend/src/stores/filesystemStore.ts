/**
 * filesystemStore — project tree + expand/collapse + creation helpers.
 *
 * This store is the source of truth for the left file tree panel. Document
 * content itself still lives in documentStore, loaded lazily on file open.
 */

import { create } from 'zustand'
import { filesystemApi, type ProjectTree } from '../services/filesystemApi'

interface FilesystemState {
  tree: ProjectTree | null
  loading: boolean
  error: string | null

  expandedFolderIds: Record<string, boolean>

  loadTree: () => Promise<void>
  setExpanded: (folderId: string, expanded: boolean) => void
  toggleExpanded: (folderId: string) => void

  createFolder: (parentFolderId: string | null, name: string) => Promise<void>
  createDoc: (
    folderId: string | null,
    name: string,
    format: 'tex' | 'md' | 'txt',
    content?: string,
  ) => Promise<string | null>
}

export const useFilesystemStore = create<FilesystemState>((set, get) => ({
  tree: null,
  loading: false,
  error: null,
  expandedFolderIds: {},

  loadTree: async () => {
    set({ loading: true, error: null })
    try {
      const tree = await filesystemApi.getTree()
      set((state) => ({
        tree,
        loading: false,
        error: null,
        // keep existing expanded states; ensure root is expanded
        expandedFolderIds: {
          root: true,
          ...state.expandedFolderIds,
        },
      }))
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  },

  setExpanded: (folderId, expanded) => {
    set((state) => ({
      expandedFolderIds: {
        ...state.expandedFolderIds,
        [folderId]: expanded,
      },
    }))
  },

  toggleExpanded: (folderId) => {
    const current = get().expandedFolderIds[folderId] ?? false
    get().setExpanded(folderId, !current)
  },

  createFolder: async (parentFolderId, name) => {
    await filesystemApi.createFolder({
      parent_folder_id: parentFolderId,
      name,
    })
    await get().loadTree()
  },

  createDoc: async (folderId, name, format, content) => {
    const doc = await filesystemApi.createDoc({
      folder_id: folderId,
      name,
      format,
      content,
    })
    await get().loadTree()
    return doc.id
  },
}))

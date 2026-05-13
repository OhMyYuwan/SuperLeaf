/**
 * filesystemStore — project tree + expand/collapse + creation helpers.
 *
 * This store is the source of truth for the left file tree panel. Document
 * content itself still lives in documentStore, loaded lazily on file open.
 */

import { create } from 'zustand'
import { filesystemApi, type ProjectTree, type TreeFile } from '../services/filesystemApi'

export interface ActivePreviewFile {
  id: string
  name: string
  mimeType: string
  url: string
}

interface FilesystemState {
  tree: ProjectTree | null
  loading: boolean
  error: string | null

  expandedFolderIds: Record<string, boolean>

  activePreviewFile: ActivePreviewFile | null

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

  renameProject: (name: string) => Promise<void>

  renameEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string, name: string) => Promise<void>
  deleteEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string) => Promise<void>
  moveEntity: (
    entityType: 'folder' | 'doc' | 'file',
    entityId: string,
    targetFolderId: string | null,
  ) => Promise<void>
  uploadFile: (file: File, folderId?: string | null) => Promise<void>
  uploadFolder: (files: FileList, parentFolderId?: string | null) => Promise<void>

  setPreviewFile: (file: TreeFile | null) => void
  convertFileToDoc: (fileId: string) => Promise<string>
}

export const useFilesystemStore = create<FilesystemState>((set, get) => ({
  tree: null,
  loading: false,
  error: null,
  expandedFolderIds: {},
  activePreviewFile: null,

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

  renameProject: async (name) => {
    await filesystemApi.renameProject(name)
    await get().loadTree()
  },

  renameEntity: async (entityType, entityId, name) => {
    await filesystemApi.renameEntity(entityType, entityId, name)
    await get().loadTree()
  },

  deleteEntity: async (entityType, entityId) => {
    await filesystemApi.deleteEntity(entityType, entityId)
    await get().loadTree()
  },

  moveEntity: async (entityType, entityId, targetFolderId) => {
    await filesystemApi.moveEntity(entityType, entityId, targetFolderId)
    await get().loadTree()
  },

  uploadFile: async (file, folderId) => {
    await filesystemApi.uploadFile(file, folderId)
    await get().loadTree()
  },

  uploadFolder: async (files, parentFolderId) => {
    if (files.length === 0) return

    // Map from relative folder path (e.g. "foo/bar") to backend folder id.
    // Empty string represents the parent folder (drop target).
    const folderIdByPath = new Map<string, string | null>()
    folderIdByPath.set('', parentFolderId ?? null)

    const ensureFolder = async (folderPath: string): Promise<string | null> => {
      if (folderIdByPath.has(folderPath)) return folderIdByPath.get(folderPath)!
      const segments = folderPath.split('/').filter(Boolean)
      const parentPath = segments.slice(0, -1).join('/')
      const parentId = await ensureFolder(parentPath)
      const name = segments[segments.length - 1]
      const folder = await filesystemApi.createFolder({
        parent_folder_id: parentId,
        name,
      })
      folderIdByPath.set(folderPath, folder.id)
      return folder.id
    }

    set({ loading: true })
    try {
      for (const file of Array.from(files)) {
        // webkitRelativePath looks like "rootFolder/sub/file.txt"
        const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        const parts = relPath.split('/')
        const fileFolderPath = parts.slice(0, -1).join('/')
        const fileName = parts[parts.length - 1]
        const folderId = await ensureFolder(fileFolderPath)

        // Create a new File object with just the filename (no path)
        const renamedFile = new File([file], fileName, { type: file.type })
        await filesystemApi.uploadFile(renamedFile, folderId)
      }
    } finally {
      set({ loading: false })
      await get().loadTree()
    }
  },

  setPreviewFile: (file) => {
    if (!file) {
      set({ activePreviewFile: null })
      return
    }
    set({
      activePreviewFile: {
        id: file.id,
        name: file.name,
        mimeType: file.mime_type,
        url: filesystemApi.fileUrl(file.id),
      },
    })
  },

  convertFileToDoc: async (fileId) => {
    const doc = await filesystemApi.convertFileToDoc(fileId)
    await get().loadTree()
    return doc.id
  },
}))

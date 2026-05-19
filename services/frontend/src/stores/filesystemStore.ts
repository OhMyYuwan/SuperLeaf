/**
 * filesystemStore — project tree + expand/collapse + creation helpers.
 *
 * This store is the source of truth for the left file tree panel. Document
 * content itself still lives in documentStore, loaded lazily on file open.
 */

import { create } from 'zustand'
import { filesystemApi, type ProjectTree, type TreeDoc, type TreeFile, type TreeFolder } from '../services/filesystemApi'
import { useDocumentStore } from './documentStore'

export interface ActivePreviewFile {
  id: string
  name: string
  mimeType: string
  url: string
}

export type TreeEntityType = 'folder' | 'doc' | 'file'

export interface ProjectTreeChangePayload {
  action?: string
  entity_type?: TreeEntityType
  entity_id?: string
  target_folder_id?: string | null
  parent_folder_id?: string | null
  folder_id?: string | null
  folder?: TreeFolder
  doc?: TreeDoc
  file?: TreeFile
  doc_id?: string
  file_id?: string
  name?: string
}

interface FilesystemState {
  tree: ProjectTree | null
  loading: boolean
  error: string | null

  expandedFolderIds: Record<string, boolean>

  activePreviewFile: ActivePreviewFile | null

  loadTree: () => Promise<void>
  applyRemoteTreeChange: (payload: ProjectTreeChangePayload) => boolean
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
  uploadProjectZip: (file: File) => Promise<void>

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

  applyRemoteTreeChange: (payload) => {
    const action = typeof payload.action === 'string' ? payload.action : ''
    const tree = get().tree
    if (!tree) return false

    let nextTree: ProjectTree | null = null
    let expandFolderId: string | null = null

    switch (action) {
      case 'project.renamed': {
        const name = typeof payload.name === 'string' ? payload.name : ''
        if (!name) return false
        nextTree = {
          ...tree,
          project_name: name,
          root: { ...tree.root, name },
        }
        break
      }
      case 'folder.created': {
        if (!payload.folder) return false
        const result = insertTreeEntity(tree.root, payload.parent_folder_id ?? null, 'folder', payload.folder)
        if (!result) return false
        nextTree = { ...tree, root: result }
        expandFolderId = payload.parent_folder_id ?? 'root'
        break
      }
      case 'doc.created':
      case 'doc.uploaded': {
        if (!payload.doc) return false
        const result = insertTreeEntity(tree.root, payload.folder_id ?? null, 'doc', payload.doc)
        if (!result) return false
        nextTree = { ...tree, root: result }
        expandFolderId = payload.folder_id ?? 'root'
        break
      }
      case 'file.uploaded': {
        if (!payload.file) return false
        const result = insertTreeEntity(tree.root, payload.folder_id ?? null, 'file', payload.file)
        if (!result) return false
        nextTree = { ...tree, root: result }
        expandFolderId = payload.folder_id ?? 'root'
        break
      }
      case 'folder.renamed':
      case 'doc.renamed':
      case 'file.renamed': {
        const entityType = payload.entity_type ?? (action.split('.')[0] as TreeEntityType)
        const entityId = payload.entity_id
        const name = typeof payload.name === 'string' ? payload.name : ''
        if (!entityId || !name) return false
        const result = renameTreeEntity(tree.root, entityType, entityId, name)
        if (!result) return false
        nextTree = { ...tree, root: result }
        break
      }
      case 'folder.deleted':
      case 'doc.deleted':
      case 'file.deleted': {
        const entityType = payload.entity_type ?? (action.split('.')[0] as TreeEntityType)
        const entityId = payload.entity_id
        if (!entityId) return false
        clearActiveEntityReferences(tree, entityType, entityId, set)
        const result = deleteTreeEntity(tree.root, entityType, entityId)
        if (!result) return false
        nextTree = { ...tree, root: result }
        break
      }
      case 'folder.moved':
      case 'doc.moved':
      case 'file.moved': {
        const entityType = payload.entity_type ?? (action.split('.')[0] as TreeEntityType)
        const entityId = payload.entity_id
        if (!entityId) return false
        const found = findTreeEntity(tree.root, entityType, entityId)
        if (!found) return false
        const without = deleteTreeEntity(tree.root, entityType, entityId)
        if (!without) return false
        const result = insertTreeEntity(without, payload.target_folder_id ?? null, entityType, found.entity)
        if (!result) return false
        nextTree = { ...tree, root: result }
        expandFolderId = payload.target_folder_id ?? 'root'
        break
      }
      case 'file.converted_to_doc': {
        const fileId = payload.file_id
        if (!fileId || !payload.doc) return false
        clearActiveEntityReferences(tree, 'file', fileId, set)
        const without = deleteTreeEntity(tree.root, 'file', fileId)
        if (!without) return false
        const result = insertTreeEntity(without, payload.folder_id ?? null, 'doc', payload.doc)
        if (!result) return false
        nextTree = { ...tree, root: result }
        expandFolderId = payload.folder_id ?? 'root'
        break
      }
      default:
        return false
    }

    if (!nextTree) return false

    set((state) => ({
      tree: nextTree,
      expandedFolderIds: expandFolderId
        ? {
            ...state.expandedFolderIds,
            [expandFolderId]: true,
          }
        : state.expandedFolderIds,
    }))
    return true
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
    const tree = get().tree
    const activeDocumentId = useDocumentStore.getState().activeDocumentId
    const activePreviewFileId = get().activePreviewFile?.id ?? null
    const clearsActiveDoc = activeDocumentId
      ? entityDeletesDoc(tree, entityType, entityId, activeDocumentId)
      : false
    const clearsActivePreview = activePreviewFileId
      ? entityDeletesFile(tree, entityType, entityId, activePreviewFileId)
      : false

    await filesystemApi.deleteEntity(entityType, entityId)

    if (clearsActiveDoc && activeDocumentId) {
      useDocumentStore.getState().removeDocument(activeDocumentId)
    }
    if (clearsActivePreview) {
      set({ activePreviewFile: null })
    }

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

  uploadProjectZip: async (file) => {
    set({ loading: true, error: null })
    try {
      const documentStore = useDocumentStore.getState()
      for (const id of Object.keys(documentStore.documents)) {
        documentStore.removeDocument(id)
      }
      set({
        activePreviewFile: null,
        expandedFolderIds: { root: true },
      })
      await filesystemApi.importProjectZip(file)
      await get().loadTree()
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      set({ error })
      throw e
    } finally {
      set({ loading: false })
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

type TreeEntity = TreeFolder | TreeDoc | TreeFile

function insertTreeEntity(
  root: TreeFolder,
  parentFolderId: string | null,
  entityType: TreeEntityType,
  entity: TreeEntity,
): TreeFolder | null {
  const targetId = parentFolderId ?? 'root'
  const result = updateFolderById(root, targetId, (folder) => {
    if (entityType === 'folder') {
      const newFolder = normalizeTreeFolder(entity as TreeFolder)
      if (folder.folders.some((item) => item.id === newFolder.id)) return folder
      return {
        ...folder,
        folders: sortByName([...folder.folders, newFolder]),
      }
    }
    if (entityType === 'doc') {
      const doc = entity as TreeDoc
      if (folder.docs.some((item) => item.id === doc.id)) return folder
      return {
        ...folder,
        docs: sortByName([...folder.docs, doc]),
      }
    }
    const file = entity as TreeFile
    if (folder.files.some((item) => item.id === file.id)) return folder
    return {
      ...folder,
      files: sortByName([...folder.files, file]),
    }
  })
  return result.changed ? result.folder : null
}

function renameTreeEntity(
  folder: TreeFolder,
  entityType: TreeEntityType,
  entityId: string,
  name: string,
): TreeFolder | null {
  if (entityType === 'folder' && folder.id === entityId) {
    return { ...folder, name }
  }

  let changed = false
  let nextFolder = folder

  if (entityType === 'folder') {
    const nextFolders = folder.folders.map((child) => {
      const renamed = renameTreeEntity(child, entityType, entityId, name)
      if (!renamed) return child
      changed = true
      return renamed
    })
    if (changed) nextFolder = { ...nextFolder, folders: nextFolders }
  }

  if (entityType === 'doc') {
    const nextDocs = folder.docs.map((doc) => {
      if (doc.id !== entityId) return doc
      changed = true
      return { ...doc, name }
    })
    if (changed) nextFolder = { ...nextFolder, docs: nextDocs }
  }

  if (entityType === 'file') {
    const nextFiles = folder.files.map((file) => {
      if (file.id !== entityId) return file
      changed = true
      return { ...file, name }
    })
    if (changed) nextFolder = { ...nextFolder, files: nextFiles }
  }

  if (changed) return nextFolder

  const childFolders = folder.folders.map((child) => {
    const renamed = renameTreeEntity(child, entityType, entityId, name)
    if (!renamed) return child
    changed = true
    return renamed
  })
  return changed ? { ...folder, folders: childFolders } : null
}

function deleteTreeEntity(
  folder: TreeFolder,
  entityType: TreeEntityType,
  entityId: string,
): TreeFolder | null {
  let changed = false

  const nextFolders = folder.folders.flatMap((child) => {
    if (entityType === 'folder' && child.id === entityId) {
      changed = true
      return []
    }
    const updated = deleteTreeEntity(child, entityType, entityId)
    if (!updated) return [child]
    changed = true
    return [updated]
  })

  let nextDocs = folder.docs
  if (entityType === 'doc') {
    nextDocs = folder.docs.filter((doc) => doc.id !== entityId)
    changed ||= nextDocs.length !== folder.docs.length
  }

  let nextFiles = folder.files
  if (entityType === 'file') {
    nextFiles = folder.files.filter((file) => file.id !== entityId)
    changed ||= nextFiles.length !== folder.files.length
  }

  return changed
    ? {
        ...folder,
        folders: nextFolders,
        docs: nextDocs,
        files: nextFiles,
      }
    : null
}

function findTreeEntity(
  folder: TreeFolder,
  entityType: TreeEntityType,
  entityId: string,
): { entity: TreeEntity; parentFolderId: string | null } | null {
  if (entityType === 'folder') {
    for (const child of folder.folders) {
      if (child.id === entityId) {
        return { entity: child, parentFolderId: folder.id === 'root' ? null : folder.id }
      }
    }
  }
  if (entityType === 'doc') {
    const doc = folder.docs.find((item) => item.id === entityId)
    if (doc) return { entity: doc, parentFolderId: folder.id === 'root' ? null : folder.id }
  }
  if (entityType === 'file') {
    const file = folder.files.find((item) => item.id === entityId)
    if (file) return { entity: file, parentFolderId: folder.id === 'root' ? null : folder.id }
  }

  for (const child of folder.folders) {
    const found = findTreeEntity(child, entityType, entityId)
    if (found) return found
  }
  return null
}

function updateFolderById(
  folder: TreeFolder,
  folderId: string,
  updater: (folder: TreeFolder) => TreeFolder,
): { folder: TreeFolder; changed: boolean } {
  if (folder.id === folderId) {
    const updated = updater(folder)
    return { folder: updated, changed: updated !== folder }
  }

  let changed = false
  const folders = folder.folders.map((child) => {
    const result = updateFolderById(child, folderId, updater)
    if (!result.changed) return child
    changed = true
    return result.folder
  })

  return changed ? { folder: { ...folder, folders }, changed: true } : { folder, changed: false }
}

function normalizeTreeFolder(folder: TreeFolder): TreeFolder {
  return {
    ...folder,
    folders: folder.folders ?? [],
    docs: folder.docs ?? [],
    files: folder.files ?? [],
  }
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name))
}

function clearActiveEntityReferences(
  tree: ProjectTree,
  entityType: TreeEntityType,
  entityId: string,
  setState: (partial: Partial<FilesystemState>) => void,
): void {
  const activeDocumentId = useDocumentStore.getState().activeDocumentId
  const activePreviewFileId = useFilesystemStore.getState().activePreviewFile?.id ?? null
  const clearsActiveDoc = activeDocumentId
    ? entityDeletesDoc(tree, entityType, entityId, activeDocumentId)
    : false
  const clearsActivePreview = activePreviewFileId
    ? entityDeletesFile(tree, entityType, entityId, activePreviewFileId)
    : false

  if (clearsActiveDoc && activeDocumentId) {
    useDocumentStore.getState().removeDocument(activeDocumentId)
  }
  if (clearsActivePreview) {
    setState({ activePreviewFile: null })
  }
}

function entityDeletesDoc(
  tree: ProjectTree | null,
  entityType: TreeEntityType,
  entityId: string,
  docId: string,
): boolean {
  if (entityType === 'doc') return entityId === docId
  if (entityType !== 'folder' || !tree) return false
  const folder = findFolder(tree.root, entityId)
  return folder ? folderContainsDoc(folder, docId) : false
}

function entityDeletesFile(
  tree: ProjectTree | null,
  entityType: TreeEntityType,
  entityId: string,
  fileId: string,
): boolean {
  if (entityType === 'file') return entityId === fileId
  if (entityType !== 'folder' || !tree) return false
  const folder = findFolder(tree.root, entityId)
  return folder ? folderContainsFile(folder, fileId) : false
}

function findFolder(folder: TreeFolder, folderId: string): TreeFolder | null {
  if (folder.id === folderId) return folder
  for (const child of folder.folders) {
    const found = findFolder(child, folderId)
    if (found) return found
  }
  return null
}

function folderContainsDoc(folder: TreeFolder, docId: string): boolean {
  if (folder.docs.some((doc) => doc.id === docId)) return true
  return folder.folders.some((child) => folderContainsDoc(child, docId))
}

function folderContainsFile(folder: TreeFolder, fileId: string): boolean {
  if (folder.files.some((file) => file.id === fileId)) return true
  return folder.folders.some((child) => folderContainsFile(child, fileId))
}

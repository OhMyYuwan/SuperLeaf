import type { TreeFolder } from '../../services/filesystemApi'

export const FOLDER_DRAG_EXPAND_DELAY_MS = 1000
export type LocalDragPayloadKind = 'file' | 'folder' | null

interface FolderDragExpandState {
  canAcceptDrop: boolean
  expanded: boolean
  isRoot: boolean
}

export function hasLocalDroppedFiles(dataTransfer: DataTransfer): boolean {
  return getLocalDroppedFiles(dataTransfer).length > 0
}

export function hasLocalFileDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types ?? [])
  return hasLocalDroppedFiles(dataTransfer) || types.some((type) => type.toLowerCase() === 'files')
}

export function getLocalDragPayloadKind(dataTransfer: DataTransfer): LocalDragPayloadKind {
  if (!hasLocalFileDrag(dataTransfer)) return null
  if (hasLocalFolderEntry(dataTransfer)) return 'folder'
  return 'file'
}

export function getLocalDroppedFiles(dataTransfer: DataTransfer): File[] {
  return Array.from(dataTransfer.files ?? []).filter((file) => file instanceof File)
}

export function getDroppedFileReplaceConflicts(folder: TreeFolder, files: File[]): string[] {
  const existingNames = new Set([
    ...folder.docs.map((doc) => doc.name),
    ...folder.files.map((file) => file.name),
  ])
  const conflicts: string[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (!existingNames.has(file.name) || seen.has(file.name)) continue
    seen.add(file.name)
    conflicts.push(file.name)
  }
  return conflicts
}

export function shouldAutoExpandFolderOnDrag({
  canAcceptDrop,
  expanded,
  isRoot,
}: FolderDragExpandState): boolean {
  return canAcceptDrop && !expanded && !isRoot
}

function hasLocalFolderEntry(dataTransfer: DataTransfer): boolean {
  const items = Array.from(dataTransfer.items ?? [])
  return items.some((item) => {
    if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') return false
    return item.webkitGetAsEntry()?.isDirectory === true
  })
}

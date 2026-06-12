import { describe, expect, it } from 'vitest'
import {
  FOLDER_DRAG_EXPAND_DELAY_MS,
  getDroppedFileReplaceConflicts,
  getLocalDragPayloadKind,
  getLocalDroppedFiles,
  hasLocalFileDrag,
  hasLocalDroppedFiles,
  shouldAutoExpandFolderOnDrag,
} from './dropUtils'
import type { TreeFolder } from '../../services/filesystemApi'

function transferWithFiles(files: File[]) {
  return {
    files,
    types: ['Files'],
  } as unknown as DataTransfer
}

function transferWithoutFiles() {
  return {
    files: [],
    types: ['application/x-ylw-entity'],
  } as unknown as DataTransfer
}

function transferWithFileTypeOnly() {
  return {
    files: [],
    types: ['Files'],
  } as unknown as DataTransfer
}

function transferWithDirectoryEntry() {
  return {
    files: [],
    items: [
      {
        kind: 'file',
        webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }),
      },
    ],
    types: ['Files'],
  } as unknown as DataTransfer
}

describe('file-tree local drop utilities', () => {
  it('detects and returns local files from a DataTransfer payload', () => {
    const first = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    const second = new File(['%PDF'], 'paper.pdf', { type: 'application/pdf' })
    const transfer = transferWithFiles([first, second])

    expect(hasLocalDroppedFiles(transfer)).toBe(true)
    expect(hasLocalFileDrag(transfer)).toBe(true)
    expect(getLocalDroppedFiles(transfer)).toEqual([first, second])
  })

  it('ignores internal project entity drags without local files', () => {
    const transfer = transferWithoutFiles()

    expect(hasLocalDroppedFiles(transfer)).toBe(false)
    expect(hasLocalFileDrag(transfer)).toBe(false)
    expect(getLocalDroppedFiles(transfer)).toEqual([])
  })

  it('detects local file drags before dropped files are exposed', () => {
    const transfer = transferWithFileTypeOnly()

    expect(hasLocalFileDrag(transfer)).toBe(true)
    expect(hasLocalDroppedFiles(transfer)).toBe(false)
    expect(getLocalDragPayloadKind(transfer)).toBe('file')
  })

  it('detects local folder drags when browser entry metadata is available', () => {
    const transfer = transferWithDirectoryEntry()

    expect(hasLocalFileDrag(transfer)).toBe(true)
    expect(getLocalDragPayloadKind(transfer)).toBe('folder')
  })

  it('returns unique dropped file names that would replace docs or files in a folder', () => {
    const folder = {
      id: 'f1',
      name: 'Figures',
      folders: [],
      docs: [
        { id: 'd1', name: 'notes.tex', format: 'tex', size_bytes: 4, updated_at: '' },
      ],
      files: [
        { id: 'b1', name: 'plot.png', mime_type: 'image/png', size_bytes: 10, updated_at: '' },
      ],
    } satisfies TreeFolder
    const files = [
      new File(['new'], 'new.txt'),
      new File(['notes'], 'notes.tex'),
      new File(['plot'], 'plot.png'),
      new File(['plot copy'], 'plot.png'),
    ]

    expect(getDroppedFileReplaceConflicts(folder, files)).toEqual(['notes.tex', 'plot.png'])
  })

  it('auto-expands only accepted collapsed non-root folder drag targets after one second', () => {
    expect(FOLDER_DRAG_EXPAND_DELAY_MS).toBe(1000)
    expect(shouldAutoExpandFolderOnDrag({
      canAcceptDrop: true,
      expanded: false,
      isRoot: false,
    })).toBe(true)
    expect(shouldAutoExpandFolderOnDrag({
      canAcceptDrop: true,
      expanded: true,
      isRoot: false,
    })).toBe(false)
    expect(shouldAutoExpandFolderOnDrag({
      canAcceptDrop: true,
      expanded: false,
      isRoot: true,
    })).toBe(false)
    expect(shouldAutoExpandFolderOnDrag({
      canAcceptDrop: false,
      expanded: false,
      isRoot: false,
    })).toBe(false)
  })
})

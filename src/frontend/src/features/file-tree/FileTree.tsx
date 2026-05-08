/**
 * FileTree — nested Overleaf-style tree for folders/docs/files.
 *
 * This tree is backed by `filesystemStore.tree` (from backend `/api/project/tree`).
 * It supports:
 *  - folder expand/collapse
 *  - open doc on click
 *  - quick-create folder/doc via prompt (phase A2, minimal UX)
 *
 * Binary files are listed but not opened yet (A3 will add preview/download).
 */

import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  File,
  Plus,
  FolderPlus,
} from 'lucide-react'
import type { ProjectTree, TreeFolder } from '../../services/filesystemApi'

interface FileTreeProps {
  tree: ProjectTree | null
  activeDocId: string | null
  expandedFolderIds: Record<string, boolean>
  loading: boolean
  error: string | null
  onToggleFolder: (folderId: string) => void
  onOpenDoc: (docId: string) => void
  onCreateFolder: (parentFolderId: string | null, name: string) => Promise<void>
  onCreateDoc: (
    folderId: string | null,
    name: string,
    format: 'tex' | 'md' | 'txt',
    content?: string,
  ) => Promise<string | null>
}

export function FileTree({
  tree,
  activeDocId,
  expandedFolderIds,
  loading,
  error,
  onToggleFolder,
  onOpenDoc,
  onCreateFolder,
  onCreateDoc,
}: FileTreeProps) {
  const handleCreateRootFolder = async () => {
    const name = prompt('新建文件夹名称')?.trim()
    if (!name) return
    await onCreateFolder(null, name)
  }

  const handleCreateRootDoc = async () => {
    const name = prompt('新建文档名称（例如 main.tex）')?.trim()
    if (!name) return
    const format = inferFormat(name)
    const id = await onCreateDoc(null, name, format, defaultContent(format))
    if (id) onOpenDoc(id)
  }

  return (
    <div className="panel-section">
      <div className="section-title tree-header-row">
        <span className="tree-title">
          <Folder size={16} /> 文件管理
        </span>
        <span className="tree-actions">
          <button className="tree-action-btn" title="新建文件夹" onClick={handleCreateRootFolder}>
            <FolderPlus size={13} />
          </button>
          <button className="tree-action-btn" title="新建文档" onClick={handleCreateRootDoc}>
            <Plus size={13} />
          </button>
        </span>
      </div>

      {loading && <div className="outline-empty">正在加载文件树…</div>}
      {error && <div className="tree-error">{error}</div>}

      <div className="file-list tree-list">
        {!loading && !tree && <div className="outline-empty">暂无项目数据</div>}
        {tree && (
          <FolderNode
            folder={tree.root}
            depth={0}
            activeDocId={activeDocId}
            expandedFolderIds={expandedFolderIds}
            onToggleFolder={onToggleFolder}
            onOpenDoc={onOpenDoc}
            onCreateFolder={onCreateFolder}
            onCreateDoc={onCreateDoc}
          />
        )}
      </div>
    </div>
  )
}

interface FolderNodeProps {
  folder: TreeFolder
  depth: number
  activeDocId: string | null
  expandedFolderIds: Record<string, boolean>
  onToggleFolder: (folderId: string) => void
  onOpenDoc: (docId: string) => void
  onCreateFolder: (parentFolderId: string | null, name: string) => Promise<void>
  onCreateDoc: (
    folderId: string | null,
    name: string,
    format: 'tex' | 'md' | 'txt',
    content?: string,
  ) => Promise<string | null>
}

function FolderNode({
  folder,
  depth,
  activeDocId,
  expandedFolderIds,
  onToggleFolder,
  onOpenDoc,
  onCreateFolder,
  onCreateDoc,
}: FolderNodeProps) {
  const expanded = depth === 0 ? true : !!expandedFolderIds[folder.id]
  const leftPad = 10 + depth * 14

  const handleCreateSubFolder = async () => {
    const name = prompt(`在 ${folder.name} 下新建文件夹`)?.trim()
    if (!name) return
    await onCreateFolder(depth === 0 ? null : folder.id, name)
  }

  const handleCreateDoc = async () => {
    const name = prompt(`在 ${folder.name} 下新建文档（例如 section.md）`)?.trim()
    if (!name) return
    const format = inferFormat(name)
    const id = await onCreateDoc(depth === 0 ? null : folder.id, name, format, defaultContent(format))
    if (id) onOpenDoc(id)
  }

  return (
    <div className="tree-folder-block">
      <div className="file-item tree-folder-row" style={{ paddingLeft: leftPad }}>
        {depth > 0 ? (
          <button className="tree-toggle-btn" onClick={() => onToggleFolder(folder.id)}>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="tree-toggle-placeholder" />
        )}
        {expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
        <span className="tree-node-name">{folder.name}</span>
        <span className="tree-actions inline">
          <button className="tree-action-btn" title="新建子文件夹" onClick={handleCreateSubFolder}>
            <FolderPlus size={12} />
          </button>
          <button className="tree-action-btn" title="新建文档" onClick={handleCreateDoc}>
            <Plus size={12} />
          </button>
        </span>
      </div>

      {expanded && (
        <>
          {folder.docs.map((doc) => (
            <button
              key={doc.id}
              className={`file-item tree-doc-row ${activeDocId === doc.id ? 'active' : ''}`}
              style={{ paddingLeft: leftPad + 28 }}
              onClick={() => onOpenDoc(doc.id)}
              title={`${doc.name} (${doc.format.toUpperCase()})`}
            >
              <FileText size={14} />
              <span className="tree-node-name">{doc.name}</span>
            </button>
          ))}

          {folder.files.map((file) => (
            <div
              key={file.id}
              className="file-item tree-file-row"
              style={{ paddingLeft: leftPad + 28 }}
              title={`${file.name} (${prettySize(file.size_bytes)})`}
            >
              <File size={14} />
              <span className="tree-node-name">{file.name}</span>
            </div>
          ))}

          {folder.folders.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              depth={depth + 1}
              activeDocId={activeDocId}
              expandedFolderIds={expandedFolderIds}
              onToggleFolder={onToggleFolder}
              onOpenDoc={onOpenDoc}
              onCreateFolder={onCreateFolder}
              onCreateDoc={onCreateDoc}
            />
          ))}
        </>
      )}
    </div>
  )
}

function inferFormat(name: string): 'tex' | 'md' | 'txt' {
  const lower = name.toLowerCase()
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.txt')) return 'txt'
  return 'tex'
}

function defaultContent(format: 'tex' | 'md' | 'txt') {
  if (format === 'md') return '# New Document\n\n'
  if (format === 'txt') return ''
  return '\\section{New Section}\n\n'
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

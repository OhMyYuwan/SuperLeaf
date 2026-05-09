import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  File,
  Plus,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
  Download,
  FileCode,
  FileType,
} from 'lucide-react'
import { filesystemApi, type ProjectTree, type TreeFolder, type TreeDoc, type TreeFile } from '../../services/filesystemApi'

// Helper function to get file icon based on format/extension
function getFileIcon(name: string, format?: string) {
  const ext = format || name.split('.').pop()?.toLowerCase()

  switch (ext) {
    case 'tex':
      return { icon: FileCode, color: '#4ade80' } // Green for LaTeX
    case 'md':
    case 'markdown':
      return { icon: FileText, color: '#60a5fa' } // Blue for Markdown
    case 'txt':
      return { icon: FileType, color: '#94a3b8' } // Gray for plain text
    default:
      return { icon: File, color: '#94a3b8' } // Default gray
  }
}

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
  onRenameEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string, name: string) => Promise<void>
  onDeleteEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string) => Promise<void>
  onUploadFile: (file: File, folderId?: string | null) => Promise<void>
  onRenameProject: (name: string) => Promise<void>
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
  onRenameEntity,
  onDeleteEntity,
  onUploadFile,
  onRenameProject,
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

  const handleUploadRoot = () => {
    triggerUpload((file) => onUploadFile(file, null))
  }

  const handleRenameProject = () => {
    const name = prompt('重命名项目', tree?.project_name ?? '')?.trim()
    if (!name || name === tree?.project_name) return
    onRenameProject(name)
  }

  const handleExport = () => {
    const a = document.createElement('a')
    a.href = filesystemApi.exportZipUrl()
    a.download = 'project.zip'
    a.click()
  }

  return (
    <div className="panel-section">
      <div className="section-title tree-header-row">
        <span className="tree-title">
          <Folder size={16} /> {tree?.project_name ?? '文件管理'}
          <button className="tree-action-btn" title="重命名项目" onClick={handleRenameProject}>
            <Pencil size={11} />
          </button>
        </span>
        <span className="tree-actions">
          <button className="tree-action-btn" title="上传文件" onClick={handleUploadRoot}>
            <Upload size={13} />
          </button>
          <button className="tree-action-btn" title="导出 ZIP" onClick={handleExport}>
            <Download size={13} />
          </button>
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
            onRenameEntity={onRenameEntity}
            onDeleteEntity={onDeleteEntity}
            onUploadFile={onUploadFile}
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
  onRenameEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string, name: string) => Promise<void>
  onDeleteEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string) => Promise<void>
  onUploadFile: (file: File, folderId?: string | null) => Promise<void>
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
  onRenameEntity,
  onDeleteEntity,
  onUploadFile,
}: FolderNodeProps) {
  const expanded = depth === 0 ? true : !!expandedFolderIds[folder.id]
  const leftPad = depth === 0 ? 0 : 10 + (depth - 1) * 14
  const isRoot = depth === 0
  const folderId = isRoot ? null : folder.id

  const handleCreateSubFolder = async () => {
    const name = prompt(`在 ${folder.name} 下新建文件夹`)?.trim()
    if (!name) return
    await onCreateFolder(folderId, name)
  }

  const handleCreateDoc = async () => {
    const name = prompt(`在 ${folder.name} 下新建文档（例如 section.md）`)?.trim()
    if (!name) return
    const format = inferFormat(name)
    const id = await onCreateDoc(folderId, name, format, defaultContent(format))
    if (id) onOpenDoc(id)
  }

  const handleRenameFolder = (e: React.MouseEvent) => {
    e.stopPropagation()
    const name = prompt('重命名文件夹', folder.name)?.trim()
    if (!name || name === folder.name) return
    onRenameEntity('folder', folder.id, name)
  }

  const handleDeleteFolder = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm(`确定删除文件夹「${folder.name}」？\n将同时删除所有子文件夹和文档。`)) return
    onDeleteEntity('folder', folder.id)
  }

  const handleUpload = (e: React.MouseEvent) => {
    e.stopPropagation()
    triggerUpload((file) => onUploadFile(file, folderId))
  }

  const handleRenameDoc = (e: React.MouseEvent, doc: TreeDoc) => {
    e.stopPropagation()
    const name = prompt('重命名文档', doc.name)?.trim()
    if (!name || name === doc.name) return
    onRenameEntity('doc', doc.id, name)
  }

  const handleDeleteDoc = (e: React.MouseEvent, doc: TreeDoc) => {
    e.stopPropagation()
    if (!confirm(`确定删除文档「${doc.name}」？`)) return
    onDeleteEntity('doc', doc.id)
  }

  const handleRenameFile = (e: React.MouseEvent, file: TreeFile) => {
    e.stopPropagation()
    const name = prompt('重命名文件', file.name)?.trim()
    if (!name || name === file.name) return
    onRenameEntity('file', file.id, name)
  }

  const handleDeleteFile = (e: React.MouseEvent, file: TreeFile) => {
    e.stopPropagation()
    if (!confirm(`确定删除文件「${file.name}」？`)) return
    onDeleteEntity('file', file.id)
  }

  const children = (
    <>
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
          onRenameEntity={onRenameEntity}
          onDeleteEntity={onDeleteEntity}
          onUploadFile={onUploadFile}
        />
      ))}

      {folder.docs.map((doc) => {
        const { icon: Icon, color } = getFileIcon(doc.name, doc.format)
        return (
          <div
            key={doc.id}
            className={`file-item tree-doc-row ${activeDocId === doc.id ? 'active' : ''}`}
            style={{ paddingLeft: leftPad + 28 }}
            onClick={() => onOpenDoc(doc.id)}
            title={`${doc.name} (${doc.format.toUpperCase()})`}
          >
            <Icon size={14} style={{ color }} />
            <span className="tree-node-name">{doc.name}</span>
            <span className="tree-actions inline">
              <button className="tree-action-btn" title="重命名" onClick={(e) => handleRenameDoc(e, doc)}>
                <Pencil size={11} />
              </button>
              <button className="tree-action-btn" title="删除" onClick={(e) => handleDeleteDoc(e, doc)}>
                <Trash2 size={11} />
              </button>
            </span>
          </div>
        )
      })}

      {folder.files.map((file) => {
        const { icon: Icon, color } = getFileIcon(file.name)
        return (
          <div
            key={file.id}
            className="file-item tree-file-row"
            style={{ paddingLeft: leftPad + 28 }}
            title={`${file.name} (${prettySize(file.size_bytes)})`}
          >
            <Icon size={14} style={{ color }} />
            <span className="tree-node-name">{file.name}</span>
            <span className="tree-actions inline">
              <button className="tree-action-btn" title="重命名" onClick={(e) => handleRenameFile(e, file)}>
                <Pencil size={11} />
              </button>
              <button className="tree-action-btn" title="删除" onClick={(e) => handleDeleteFile(e, file)}>
                <Trash2 size={11} />
              </button>
            </span>
          </div>
        )
      })}
    </>
  )

  if (isRoot) return <div className="tree-folder-block">{children}</div>

  return (
    <div className="tree-folder-block">
      <div className="file-item tree-folder-row" style={{ paddingLeft: leftPad }}>
        <button className="tree-toggle-btn" onClick={() => onToggleFolder(folder.id)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
        <span className="tree-node-name">{folder.name}</span>
        <span className="tree-actions inline">
          <button className="tree-action-btn" title="上传文件" onClick={handleUpload}>
            <Upload size={11} />
          </button>
          <button className="tree-action-btn" title="新建子文件夹" onClick={handleCreateSubFolder}>
            <FolderPlus size={12} />
          </button>
          <button className="tree-action-btn" title="新建文档" onClick={handleCreateDoc}>
            <Plus size={12} />
          </button>
          <button className="tree-action-btn" title="重命名" onClick={handleRenameFolder}>
            <Pencil size={11} />
          </button>
          <button className="tree-action-btn" title="删除" onClick={handleDeleteFolder}>
            <Trash2 size={11} />
          </button>
        </span>
      </div>

      {expanded && children}
    </div>
  )
}

function triggerUpload(onFile: (file: File) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) onFile(file)
  }
  input.click()
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

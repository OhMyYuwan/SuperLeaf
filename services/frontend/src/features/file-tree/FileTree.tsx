import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  File,
  Plus,
  FolderPlus,
  FolderUp,
  FileArchive,
  Pencil,
  Trash2,
  Upload,
  Download,
  FileCode,
  FileType,
} from 'lucide-react'
import { filesystemApi, type ProjectTree, type TreeFolder, type TreeDoc, type TreeFile } from '../../services/filesystemApi'
import { useProjectStore } from '../../stores/projectStore'
import {
  FOLDER_DRAG_EXPAND_DELAY_MS,
  getDroppedFileReplaceConflicts,
  getLocalDragPayloadKind,
  getLocalDroppedFiles,
  hasLocalFileDrag,
  type LocalDragPayloadKind,
  shouldAutoExpandFolderOnDrag,
} from './dropUtils'

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
  activeFileId?: string | null
  expandedFolderIds: Record<string, boolean>
  loading: boolean
  error: string | null
  onToggleFolder: (folderId: string) => void
  onOpenDoc: (docId: string) => void
  onOpenFile?: (file: TreeFile) => void
  onCreateFolder: (parentFolderId: string | null, name: string) => Promise<void>
  onCreateDoc: (
    folderId: string | null,
    name: string,
    format: 'tex' | 'md' | 'txt',
    content?: string,
  ) => Promise<string | null>
  onRenameEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string, name: string) => Promise<void>
  onDeleteEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string) => Promise<void>
  onMoveEntity: (
    entityType: 'folder' | 'doc' | 'file',
    entityId: string,
    targetFolderId: string | null,
  ) => Promise<void>
  onUploadFile: (file: File, folderId?: string | null) => Promise<void>
  onUploadFolder: (files: FileList, parentFolderId?: string | null) => Promise<void>
  onUploadProjectZip: (file: File) => Promise<void>
  onRenameProject: (name: string) => Promise<void>
}

export function FileTree({
  tree,
  activeDocId,
  activeFileId,
  expandedFolderIds,
  loading,
  error,
  onToggleFolder,
  onOpenDoc,
  onOpenFile,
  onCreateFolder,
  onCreateDoc,
  onRenameEntity,
  onDeleteEntity,
  onMoveEntity,
  onUploadFile,
  onUploadFolder,
  onUploadProjectZip,
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
    if (tree && !confirmReplaceExisting(tree.root, name)) return
    const format = inferFormat(name)
    const id = await onCreateDoc(null, name, format, defaultContent(format))
    if (id) onOpenDoc(id)
  }

  const handleUploadRoot = () => {
    triggerUpload((file) => {
      if (tree && !confirmReplaceExisting(tree.root, file.name)) return
      onUploadFile(file, null)
    })
  }

  const handleUploadFolderRoot = () => {
    if (!confirmFolderUploadReplace()) return
    triggerUploadFolder((files) => onUploadFolder(files, null))
  }

  const handleUploadZipRoot = () => {
    const ok = confirm(
      '导入 ZIP 会替换当前项目的全部文件树，并关闭当前打开的文档。是否继续？',
    )
    if (!ok) return
    triggerUploadZip((file) => onUploadProjectZip(file))
  }

  const handleRenameProject = () => {
    const name = prompt('重命名项目', tree?.project_name ?? '')?.trim()
    if (!name || name === tree?.project_name) return
    onRenameProject(name)
  }

  const handleExport = () => {
    const projectId = useProjectStore.getState().currentProjectId
    if (!projectId) return
    const a = document.createElement('a')
    a.href = filesystemApi.exportZipUrl(projectId)
    const name = (tree?.project_name || 'project').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project'
    a.download = `${name}.zip`
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
          <button className="tree-action-btn" title="上传文件夹" onClick={handleUploadFolderRoot}>
            <FolderUp size={13} />
          </button>
          <button className="tree-action-btn" title="导入 ZIP（替换项目）" onClick={handleUploadZipRoot}>
            <FileArchive size={13} />
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

      {loading && !tree && <div className="outline-empty">正在加载文件树…</div>}
      {error && <div className="tree-error">{error}</div>}

      <div className="file-list tree-list">
        {!loading && !tree && <div className="outline-empty">暂无项目数据</div>}
        {tree && (
          <FolderNode
            folder={tree.root}
            depth={0}
            activeDocId={activeDocId}
            activeFileId={activeFileId ?? null}
            loading={loading}
            expandedFolderIds={expandedFolderIds}
            onToggleFolder={onToggleFolder}
            onOpenDoc={onOpenDoc}
            onOpenFile={onOpenFile}
            onCreateFolder={onCreateFolder}
            onCreateDoc={onCreateDoc}
            onRenameEntity={onRenameEntity}
            onDeleteEntity={onDeleteEntity}
            onMoveEntity={onMoveEntity}
            onUploadFile={onUploadFile}
            onUploadFolder={onUploadFolder}
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
  activeFileId: string | null
  loading: boolean
  expandedFolderIds: Record<string, boolean>
  onToggleFolder: (folderId: string) => void
  onOpenDoc: (docId: string) => void
  onOpenFile?: (file: TreeFile) => void
  onCreateFolder: (parentFolderId: string | null, name: string) => Promise<void>
  onCreateDoc: (
    folderId: string | null,
    name: string,
    format: 'tex' | 'md' | 'txt',
    content?: string,
  ) => Promise<string | null>
  onRenameEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string, name: string) => Promise<void>
  onDeleteEntity: (entityType: 'folder' | 'doc' | 'file', entityId: string) => Promise<void>
  onMoveEntity: (
    entityType: 'folder' | 'doc' | 'file',
    entityId: string,
    targetFolderId: string | null,
  ) => Promise<void>
  onUploadFile: (file: File, folderId?: string | null) => Promise<void>
  onUploadFolder: (files: FileList, parentFolderId?: string | null) => Promise<void>
}

function FolderNode({
  folder,
  depth,
  activeDocId,
  activeFileId,
  loading,
  expandedFolderIds,
  onToggleFolder,
  onOpenDoc,
  onOpenFile,
  onCreateFolder,
  onCreateDoc,
  onRenameEntity,
  onDeleteEntity,
  onMoveEntity,
  onUploadFile,
  onUploadFolder,
}: FolderNodeProps) {
  const expanded = depth === 0 ? true : !!expandedFolderIds[folder.id]
  const leftPad = depth === 0 ? 0 : 10 + (depth - 1) * 14
  const isRoot = depth === 0
  const folderId = isRoot ? null : folder.id

  const [dragOver, setDragOver] = useState(false)
  const [localDragPayloadKind, setLocalDragPayloadKind] = useState<LocalDragPayloadKind>(null)
  const expandTimerRef = useRef<number | null>(null)

  const clearExpandTimer = () => {
    if (expandTimerRef.current === null) return
    window.clearTimeout(expandTimerRef.current)
    expandTimerRef.current = null
  }

  useEffect(() => clearExpandTimer, [])

  const handleDragStart = (
    e: React.DragEvent,
    entityType: 'folder' | 'doc' | 'file',
    entityId: string,
  ) => {
    e.stopPropagation()
    const payload = JSON.stringify({ entityType, entityId })
    e.dataTransfer.setData('application/x-ylw-entity', payload)
    e.dataTransfer.setData('text/plain', payload)
    e.dataTransfer.effectAllowed = 'move'
  }

  const readDragPayload = (
    e: React.DragEvent,
  ): { entityType: 'folder' | 'doc' | 'file'; entityId: string } | null => {
    const raw =
      e.dataTransfer.getData('application/x-ylw-entity') ||
      e.dataTransfer.getData('text/plain')
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (parsed && parsed.entityType && parsed.entityId) return parsed
    } catch {
      return null
    }
    return null
  }

  const handleDropOnFolder = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    setLocalDragPayloadKind(null)
    clearExpandTimer()
    const localFiles = getLocalDroppedFiles(e.dataTransfer)
    if (localFiles.length > 0) {
      const conflicts = getDroppedFileReplaceConflicts(folder, localFiles)
      if (conflicts.length > 0 && !confirmDroppedUploadReplace(conflicts)) return
      try {
        for (const file of localFiles) {
          await onUploadFile(file, folderId)
        }
      } catch (err) {
        console.error('upload dropped files failed', err)
      }
      return
    }
    const payload = readDragPayload(e)
    if (!payload) return
    // No-op when dropping a folder onto itself.
    if (payload.entityType === 'folder' && payload.entityId === folder.id) return
    try {
      await onMoveEntity(payload.entityType, payload.entityId, folderId)
    } catch (err) {
      console.error('move entity failed', err)
    }
  }

  const handleDragOverFolder = (e: React.DragEvent) => {
    const hasInternalEntity = e.dataTransfer.types.includes('application/x-ylw-entity')
    const localPayloadKind = getLocalDragPayloadKind(e.dataTransfer)
    const hasLocalFiles = localPayloadKind !== null || hasLocalFileDrag(e.dataTransfer)
    if (!hasInternalEntity && !hasLocalFiles) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = hasLocalFiles ? 'copy' : 'move'
    if (!dragOver) setDragOver(true)
    if (localDragPayloadKind !== localPayloadKind) setLocalDragPayloadKind(localPayloadKind)
    if (
      shouldAutoExpandFolderOnDrag({
        canAcceptDrop: true,
        expanded,
        isRoot,
      }) &&
      expandTimerRef.current === null
    ) {
      expandTimerRef.current = window.setTimeout(() => {
        expandTimerRef.current = null
        onToggleFolder(folder.id)
      }, FOLDER_DRAG_EXPAND_DELAY_MS)
    }
  }

  const handleDragLeaveFolder = (e: React.DragEvent) => {
    // Only clear when leaving to outside this folder block.
    const related = e.relatedTarget as Node | null
    if (related && e.currentTarget.contains(related)) return
    setDragOver(false)
    setLocalDragPayloadKind(null)
    clearExpandTimer()
  }

  const handleCreateSubFolder = async () => {
    const name = prompt(`在 ${folder.name} 下新建文件夹`)?.trim()
    if (!name) return
    await onCreateFolder(folderId, name)
  }

  const handleCreateDoc = async () => {
    const name = prompt(`在 ${folder.name} 下新建文档（例如 section.md）`)?.trim()
    if (!name) return
    if (!confirmReplaceExisting(folder, name)) return
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
    triggerUpload((file) => {
      if (!confirmReplaceExisting(folder, file.name)) return
      onUploadFile(file, folderId)
    })
  }

  const handleUploadFolder = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirmFolderUploadReplace()) return
    triggerUploadFolder((files) => onUploadFolder(files, folderId))
  }

  const handleRenameDoc = (e: React.MouseEvent, doc: TreeDoc) => {
    e.stopPropagation()
    const name = prompt('重命名文档', doc.name)?.trim()
    if (!name || name === doc.name) return
    if (!confirmReplaceExisting(folder, name, doc.id)) return
    onRenameEntity('doc', doc.id, name)
  }

  const handleDeleteDoc = (e: React.MouseEvent, doc: TreeDoc) => {
    e.stopPropagation()
    if (!confirm(`确定删除文档「${doc.name}」？`)) return
    onDeleteEntity('doc', doc.id)
  }

  const handleDownloadDoc = async (e: React.MouseEvent, doc: TreeDoc) => {
    e.stopPropagation()
    try {
      const backendDoc = await filesystemApi.getDoc(doc.id)
      const blob = new Blob([backendDoc.content ?? ''], {
        type: mimeForDocFormat(backendDoc.format),
      })
      downloadBlob(blob, backendDoc.name || doc.name)
    } catch (err) {
      console.error('download doc failed', err)
      alert('下载文档失败，请稍后重试。')
    }
  }

  const handleRenameFile = (e: React.MouseEvent, file: TreeFile) => {
    e.stopPropagation()
    const name = prompt('重命名文件', file.name)?.trim()
    if (!name || name === file.name) return
    if (!confirmReplaceExisting(folder, name, file.id)) return
    onRenameEntity('file', file.id, name)
  }

  const handleDeleteFile = (e: React.MouseEvent, file: TreeFile) => {
    e.stopPropagation()
    if (!confirm(`确定删除文件「${file.name}」？`)) return
    onDeleteEntity('file', file.id)
  }

  const handleDownloadFile = (e: React.MouseEvent, file: TreeFile) => {
    e.stopPropagation()
    const a = document.createElement('a')
    a.href = filesystemApi.fileUrl(file.id)
    a.download = file.name
    a.rel = 'noopener'
    a.click()
  }

  const children = (
    <>
      {folder.folders.map((child) => (
        <FolderNode
          key={child.id}
          folder={child}
          depth={depth + 1}
          activeDocId={activeDocId}
          activeFileId={activeFileId}
          loading={false}
          expandedFolderIds={expandedFolderIds}
          onToggleFolder={onToggleFolder}
          onOpenDoc={onOpenDoc}
          onOpenFile={onOpenFile}
          onCreateFolder={onCreateFolder}
          onCreateDoc={onCreateDoc}
          onRenameEntity={onRenameEntity}
          onDeleteEntity={onDeleteEntity}
          onMoveEntity={onMoveEntity}
          onUploadFile={onUploadFile}
          onUploadFolder={onUploadFolder}
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
            draggable
            onDragStart={(e) => handleDragStart(e, 'doc', doc.id)}
          >
            <Icon size={14} style={{ color }} />
            <span className="tree-node-name">{doc.name}</span>
            <span className="tree-actions inline">
              <button
                className="tree-action-btn"
                title="下载"
                onClick={(e) => void handleDownloadDoc(e, doc)}
              >
                <Download size={11} />
              </button>
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
            className={`file-item tree-file-row ${activeFileId === file.id ? 'active' : ''}`}
            style={{ paddingLeft: leftPad + 28 }}
            onClick={() => onOpenFile?.(file)}
            title={`${file.name} (${prettySize(file.size_bytes)})`}
            draggable
            onDragStart={(e) => handleDragStart(e, 'file', file.id)}
          >
            <Icon size={14} style={{ color }} />
            <span className="tree-node-name">{file.name}</span>
            <span className="tree-actions inline">
              <button className="tree-action-btn" title="下载" onClick={(e) => handleDownloadFile(e, file)}>
                <Download size={11} />
              </button>
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

  if (isRoot) {
    return (
      <div className={`tree-folder-block root ${dragOver ? 'drag-over' : ''} ${localDragPayloadKind === 'folder' ? 'drag-over-folder' : ''}`}>
        <div
          className="tree-root-drop-target"
          title="拖到这里上传到项目根目录，或移动项目内文件"
          onDragOver={handleDragOverFolder}
          onDragLeave={handleDragLeaveFolder}
          onDrop={handleDropOnFolder}
        >
          <FolderOpen size={14} />
          <span>项目根目录</span>
          {loading && <span className="tree-inline-loading">正在加载文件树…</span>}
        </div>
        {children}
      </div>
    )
  }

  return (
    <div className="tree-folder-block">
      <div
        className={`file-item tree-folder-row ${dragOver ? 'drag-over' : ''} ${localDragPayloadKind === 'folder' ? 'drag-over-folder' : ''}`}
        style={{ paddingLeft: leftPad }}
        title="拖本地文件到这里上传，或拖项目内文件到这里移动"
        draggable
        onDragStart={(e) => handleDragStart(e, 'folder', folder.id)}
        onDragOver={handleDragOverFolder}
        onDragLeave={handleDragLeaveFolder}
        onDrop={handleDropOnFolder}
      >
        <button className="tree-toggle-btn" onClick={() => onToggleFolder(folder.id)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
        <span className="tree-node-name">{folder.name}</span>
        <span className="tree-actions inline">
          <button className="tree-action-btn" title="上传文件" onClick={handleUpload}>
            <Upload size={11} />
          </button>
          <button className="tree-action-btn" title="上传文件夹" onClick={handleUploadFolder}>
            <FolderUp size={11} />
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

function triggerUploadFolder(onFiles: (files: FileList) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  // Non-standard but widely supported attributes for directory upload.
  input.setAttribute('webkitdirectory', '')
  input.setAttribute('directory', '')
  input.multiple = true
  input.onchange = () => {
    const files = input.files
    if (files && files.length > 0) onFiles(files)
  }
  input.click()
}

function triggerUploadZip(onFile: (file: File) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.zip,application/zip,application/x-zip-compressed'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) onFile(file)
  }
  input.click()
}

function confirmReplaceExisting(folder: TreeFolder, name: string, currentId?: string): boolean {
  const existingDoc = folder.docs.find((doc) => doc.name === name && doc.id !== currentId)
  const existingFile = folder.files.find((file) => file.name === name && file.id !== currentId)
  const existing = existingDoc ?? existingFile
  if (!existing) return true
  return confirm(`「${name}」已存在。继续操作会替换现有文件，是否继续？`)
}

function confirmFolderUploadReplace(): boolean {
  return confirm('上传文件夹时，如果目标目录中已有同名文件，将会被替换。是否继续？')
}

function confirmDroppedUploadReplace(names: string[]): boolean {
  if (names.length === 1) {
    return confirm(`「${names[0]}」已存在。继续操作会替换现有文件，是否继续？`)
  }
  const preview = names.slice(0, 8).map((name) => `- ${name}`).join('\n')
  const extra = names.length > 8 ? `\n等 ${names.length} 个文件` : ''
  return confirm(`目标目录中已有同名文件：\n${preview}${extra}\n继续操作会替换现有文件，是否继续？`)
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

function mimeForDocFormat(format: 'tex' | 'md' | 'txt'): string {
  if (format === 'md') return 'text/markdown;charset=utf-8'
  if (format === 'tex') return 'application/x-tex;charset=utf-8'
  return 'text/plain;charset=utf-8'
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

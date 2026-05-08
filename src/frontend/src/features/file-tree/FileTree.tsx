/**
 * FileTree — left-rail list of open documents.
 *
 * The "project" row is a pure visual affordance (placeholder for future
 * folder grouping); clicking an actual file sets it active via the callback.
 */

import { FileText, Folder, FolderOpen } from 'lucide-react'
import type { Document } from '../../types/document'

interface FileTreeProps {
  files: Document[]
  activeId: string | null
  onSelect: (id: string) => void
}

export function FileTree({ files, activeId, onSelect }: FileTreeProps) {
  return (
    <div className="panel-section">
      <div className="section-title">
        <Folder size={16} /> 文件管理
      </div>
      <div className="file-list">
        <button className="file-item">
          <FolderOpen size={16} />
          <span>project</span>
        </button>
        {files.map((file) => (
          <button
            key={file.id}
            className={`file-item ${activeId === file.id ? 'active' : ''}`}
            onClick={() => onSelect(file.id)}
          >
            <FileText size={16} />
            <span style={{ marginLeft: 12 }}>{file.metadata.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

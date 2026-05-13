/**
 * EditorToolbar — the header strip above the editor-split grid.
 *
 * Shows doc name + format badge + auto-save status on the left, and
 * selection info on the right.
 */

import { Check, AlertCircle, Loader2, Pencil } from 'lucide-react'
import type { Document } from '../../types/document'
import type { Selection } from '../../types/editor'
import { useDocumentStore, type SaveStatus } from '../../stores/documentStore'

interface EditorToolbarProps {
  doc: Document | null
  selection: Selection | null
}

export function EditorToolbar({ doc, selection }: EditorToolbarProps) {
  const status = useDocumentStore((s) => (doc ? s.saveStatus[doc.id] ?? 'idle' : 'idle'))
  const lastSavedAt = useDocumentStore((s) => (doc ? s.lastSavedAt[doc.id] : undefined))
  const errorMsg = useDocumentStore((s) => (doc ? s.saveError[doc.id] : null))

  return (
    <div className="editor-toolbar">
      <div className="toolbar-left">
        <div className="doc-name">{doc?.metadata.title ?? '未打开文件'}</div>
        <span className="badge">{(doc?.format ?? '').toUpperCase()}</span>
        {doc && (
          <SaveIndicator status={status} lastSavedAt={lastSavedAt} errorMsg={errorMsg} />
        )}
      </div>
      <div className="toolbar-right">
        {selection && (
          <span className="selection-info">
            选中 {selection.context.selectionLength} 字
            {selection.context.sectionTitle && ` · ${selection.context.sectionTitle}`}
          </span>
        )}
      </div>
    </div>
  )
}

interface SaveIndicatorProps {
  status: SaveStatus
  lastSavedAt: number | undefined
  errorMsg: string | null | undefined
}

function SaveIndicator({ status, lastSavedAt, errorMsg }: SaveIndicatorProps) {
  if (status === 'saving') {
    return (
      <span className="save-indicator saving" title="正在保存…">
        <Loader2 size={12} className="spin" /> 保存中
      </span>
    )
  }
  if (status === 'dirty') {
    return (
      <span className="save-indicator dirty" title="有未保存的更改 (Cmd/Ctrl+S 立即保存)">
        <Pencil size={12} /> 未保存
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="save-indicator error" title={errorMsg ?? '保存失败'}>
        <AlertCircle size={12} /> 保存失败
      </span>
    )
  }
  if (status === 'saved' || status === 'idle') {
    return (
      <span className="save-indicator saved" title={lastSavedAt ? `上次保存：${formatTime(lastSavedAt)}` : ''}>
        <Check size={12} /> {lastSavedAt ? '已保存' : '已加载'}
      </span>
    )
  }
  return null
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString()
}

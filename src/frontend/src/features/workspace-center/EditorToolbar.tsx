/**
 * EditorToolbar — the header strip above the editor-split grid.
 *
 * Shows doc name + format badge on the left, selection info on the right.
 */

import type { Document } from '../../types/document'
import type { Selection } from '../../types/editor'

interface EditorToolbarProps {
  doc: Document | null
  selection: Selection | null
}

export function EditorToolbar({ doc, selection }: EditorToolbarProps) {
  return (
    <div className="editor-toolbar">
      <div className="toolbar-left">
        <div className="doc-name">{doc?.metadata.title ?? '未打开文件'}</div>
        <span className="badge">{(doc?.format ?? '').toUpperCase()}</span>
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

/**
 * EditorColumn — the leftmost column of the workspace center grid. Mounts the
 * CodeMirror-based LatexEditor and surfaces its callbacks to the parent.
 */

import { SplitSquareVertical } from 'lucide-react'
import type { Document } from '../../types/document'
import {
  LatexEditor,
  type EditorFormat,
  type DecorationSpec,
  type DocChangeInfo,
} from '../latex-editor'

interface EditorColumnProps {
  doc: Document | null
  decorations: DecorationSpec[]
  activeAnnotationId: string | null
  scrollTo: { pos: number; seq: number } | null
  onChange: (next: string) => void
  onSelectionChange: (info: { from: number; to: number; text: string }) => void
  onDocChange: (changes: DocChangeInfo[]) => void
  onDecorationClick: (id: string) => void
}

export function EditorColumn({
  doc,
  decorations,
  activeAnnotationId,
  scrollTo,
  onChange,
  onSelectionChange,
  onDocChange,
  onDecorationClick,
}: EditorColumnProps) {
  return (
    <div className="editor-column">
      <div className="column-header">
        <SplitSquareVertical size={16} /> 编辑器
      </div>
      <div className="latex-editor-host">
        {doc ? (
          <LatexEditor
            key={doc.id}
            value={doc.content}
            format={doc.format as EditorFormat}
            onChange={onChange}
            onSelectionChange={onSelectionChange}
            onDocChange={onDocChange}
            decorations={decorations}
            activeDecorationId={activeAnnotationId}
            onDecorationClick={onDecorationClick}
            scrollTo={scrollTo}
          />
        ) : (
          <div className="editor-empty">请选择一个文件</div>
        )}
      </div>
    </div>
  )
}

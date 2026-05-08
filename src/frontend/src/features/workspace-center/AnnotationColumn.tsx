/**
 * AnnotationColumn — right column of the center workspace. Thin shell around
 * the existing AnnotationPanel so its header stays consistent with the other
 * two columns.
 */

import { MessageSquare } from 'lucide-react'
import { AnnotationPanel } from '../annotation-panel'

interface AnnotationColumnProps {
  documentId: string | null
  activeId: string | null
  onFocus: (id: string | null) => void
}

export function AnnotationColumn({ documentId, activeId, onFocus }: AnnotationColumnProps) {
  return (
    <div className="editor-column note-column">
      <div className="column-header">
        <MessageSquare size={16} /> 批注
      </div>
      <AnnotationPanel documentId={documentId} activeId={activeId} onFocus={onFocus} />
    </div>
  )
}

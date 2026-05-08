/**
 * PreviewColumn — middle column. Routes on `doc.format`:
 *   md  → MarkdownPreview
 *   tex → <pre> block with a "PDF 预览稍后接入" chip (LaTeX compile later)
 *   txt → raw <pre>
 *
 * The ScrollArea wrapper is kept here (not in the renderers) so each format's
 * content lives inside a single scrollable viewport.
 */

import * as ScrollArea from '@radix-ui/react-scroll-area'
import { Wand2 } from 'lucide-react'
import type { Document } from '../../types/document'
import { MarkdownPreview } from '../preview'

interface PreviewColumnProps {
  doc: Document | null
}

export function PreviewColumn({ doc }: PreviewColumnProps) {
  return (
    <div className="editor-column preview-column">
      <div className="column-header">
        <Wand2 size={16} /> 预览
      </div>
      <div className="preview-box">
        <ScrollArea.Root className="scroll-root">
          <ScrollArea.Viewport className="scroll-viewport">{renderBody(doc)}</ScrollArea.Viewport>
          <ScrollArea.Scrollbar className="scrollbar" orientation="vertical">
            <ScrollArea.Thumb className="thumb" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      </div>
    </div>
  )
}

function renderBody(doc: Document | null) {
  if (!doc) {
    return <div className="preview-paper empty-preview">请选择一个文件</div>
  }
  if (doc.format === 'md') {
    return <MarkdownPreview source={doc.content} />
  }
  return (
    <div className="preview-paper">
      <div className="preview-paper-meta">
        格式：{doc.format.toUpperCase()}
        {doc.format === 'tex' && <span className="soon-chip">PDF 预览稍后接入</span>}
      </div>
      <pre>{doc.content}</pre>
    </div>
  )
}

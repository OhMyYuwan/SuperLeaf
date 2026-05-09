/**
 * PreviewColumn — middle column. Routes on `doc.format`:
 *   md  → MarkdownPreview
 *   tex → LatexPreview (compiles + renders PDF via PDF.js)
 *   txt → raw <pre>
 *
 * For md/txt we wrap in a ScrollArea. LatexPreview has its own scroll + toolbar.
 */

import * as ScrollArea from '@radix-ui/react-scroll-area'
import { Wand2 } from 'lucide-react'
import type { Document } from '../../types/document'
import { MarkdownPreview, LatexPreview } from '../preview'

interface PreviewColumnProps {
  doc: Document | null
}

export function PreviewColumn({ doc }: PreviewColumnProps) {
  // LaTeX preview has its own toolbar/scroll; render directly.
  if (doc && doc.format === 'tex') {
    return (
      <div className="editor-column preview-column">
        <div className="column-header">
          <Wand2 size={16} /> 预览
        </div>
        <div className="preview-box">
          <LatexPreview documentContent={doc.content} documentVersion={doc.version} />
        </div>
      </div>
    )
  }

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
      <div className="preview-paper-meta">格式：{doc.format.toUpperCase()}</div>
      <pre>{doc.content}</pre>
    </div>
  )
}

/**
 * PreviewColumn — middle column. Routes on `doc.format`:
 *   md  → MarkdownPreview
 *   tex → LatexPreview (compiles + renders PDF via PDF.js)
 *   txt → raw <pre>
 *
 * When a binary file (image/PDF) is selected via the file tree, `previewFile`
 * takes precedence over `doc` and renders an inline preview of the raw asset.
 */

import * as ScrollArea from '@radix-ui/react-scroll-area'
import { Wand2 } from 'lucide-react'
import type { Document } from '../../types/document'
import type { ActivePreviewFile } from '../../stores/filesystemStore'
import { MarkdownPreview, LatexPreview } from '../preview'

interface PreviewColumnProps {
  doc: Document | null
  previewFile?: ActivePreviewFile | null
}

export function PreviewColumn({ doc, previewFile }: PreviewColumnProps) {
  if (previewFile) {
    return (
      <div className="editor-column preview-column">
        <div className="column-header">
          <Wand2 size={16} /> 预览：{previewFile.name}
        </div>
        <div className="preview-box">
          <FilePreview file={previewFile} />
        </div>
      </div>
    )
  }

  // LaTeX preview has its own toolbar/scroll; render directly.
  if (doc && doc.format === 'tex') {
    return (
      <div className="editor-column preview-column">
        <div className="column-header">
          <Wand2 size={16} /> 预览
        </div>
        <div className="preview-box">
          <LatexPreview documentId={doc.id} />
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

function FilePreview({ file }: { file: ActivePreviewFile }) {
  const mime = file.mimeType || guessMime(file.name)
  if (mime.startsWith('image/')) {
    return (
      <div className="preview-paper file-preview file-preview-image">
        <img src={file.url} alt={file.name} />
      </div>
    )
  }
  if (mime === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    return (
      <iframe
        className="file-preview-pdf"
        src={file.url}
        title={file.name}
        style={{ width: '100%', height: '100%', border: 0 }}
      />
    )
  }
  return (
    <div className="preview-paper empty-preview">
      该文件无法预览，
      <a href={file.url} target="_blank" rel="noopener noreferrer">
        点此在新标签页打开或下载
      </a>
      。
    </div>
  )
}

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`
  if (ext === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}

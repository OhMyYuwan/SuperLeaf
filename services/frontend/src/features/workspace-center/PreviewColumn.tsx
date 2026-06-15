/**
 * PreviewColumn — middle column. Routes on `doc.format`:
 *   md  → MarkdownPreview
 *   tex → LatexPreview (compiles + renders PDF via PDF.js)
 *   txt → raw <pre>
 *
 * When a binary file (image/PDF) is selected via the file tree, `previewFile`
 * takes precedence over `doc` and renders an inline preview of the raw asset.
 */

import { useRef, type RefObject } from 'react'
import * as ScrollArea from '@radix-ui/react-scroll-area'
import { Download, Wand2 } from 'lucide-react'
import type { Document } from '../../types/document'
import type { ActivePreviewFile } from '../../stores/filesystemStore'
import { MarkdownPreview, LatexPreview } from '../preview'
import type { SourceJump } from '../../services/previewSourceMap'
import type { PdfSourceSyncRequest } from '../preview/LatexPreview'

interface PreviewColumnProps {
  doc: Document | null
  previewFile?: ActivePreviewFile | null
  onSourceJump?: (jump: SourceJump) => void
  syncToPdfRequest?: PdfSourceSyncRequest | null
}

export function PreviewColumn({
  doc,
  previewFile,
  onSourceJump,
  syncToPdfRequest,
}: PreviewColumnProps) {
  const markdownPreviewRef = useRef<HTMLDivElement | null>(null)

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
          <LatexPreview
            documentId={doc.id}
            source={doc.content}
            onSourceJump={onSourceJump}
            syncToPdfRequest={syncToPdfRequest}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="editor-column preview-column">
      <div className="column-header preview-column-header">
        <span className="column-header-title">
          <Wand2 size={16} /> 预览
        </span>
        {doc?.format === 'md' && (
          <span className="preview-header-actions">
            <button
              className="preview-export-btn"
              type="button"
              title="导出 Markdown 预览为 PDF"
              onClick={() => exportMarkdownPreviewToPdf(doc, markdownPreviewRef.current)}
            >
              <Download size={12} /> PDF
            </button>
          </span>
        )}
      </div>
      <div className="preview-box">
        <ScrollArea.Root className="scroll-root">
          <ScrollArea.Viewport className="scroll-viewport">
            {renderBody(doc, onSourceJump, markdownPreviewRef)}
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar className="scrollbar" orientation="vertical">
            <ScrollArea.Thumb className="thumb" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      </div>
    </div>
  )
}

function renderBody(
  doc: Document | null,
  onSourceJump: ((jump: SourceJump) => void) | undefined,
  markdownPreviewRef: RefObject<HTMLDivElement | null>,
) {
  if (!doc) {
    return <div className="preview-paper empty-preview">请选择一个文件</div>
  }
  if (doc.format === 'md') {
    return <MarkdownPreview ref={markdownPreviewRef} source={doc.content} onSourceJump={onSourceJump} />
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
  if (isSafeInlineImageMime(mime)) {
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
        src={pdfPreviewUrl(file.url)}
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
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}

function isSafeInlineImageMime(mime: string): boolean {
  const normalized = mime.split(';', 1)[0].trim().toLowerCase()
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(normalized)
}

function pdfPreviewUrl(url: string): string {
  const separator = url.includes('#') ? '&' : '#'
  return `${url}${separator}navpanes=0&toolbar=0&view=FitH`
}

function exportMarkdownPreviewToPdf(doc: Document, previewElement: HTMLDivElement | null) {
  if (!previewElement) return

  const printWindow = window.open('', '_blank', 'width=920,height=1200')
  if (!printWindow) {
    alert('无法打开导出窗口。请允许浏览器弹出窗口后重试。')
    return
  }

  const fileName = markdownPdfName(doc)
  const styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
    .map((node) => node.outerHTML)
    .join('\n')

  printWindow.document.open()
  printWindow.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(fileName)}</title>
    ${styles}
    <style>
      @page { margin: 18mm; }
      html, body {
        width: auto;
        height: auto;
        margin: 0;
        background: #ffffff !important;
        color: #0f172a;
      }
      body {
        padding: 0;
      }
      .md-preview {
        width: 100% !important;
        max-width: 760px !important;
        min-height: 0 !important;
        margin: 0 auto !important;
        padding: 0 !important;
        overflow: visible !important;
        background: #ffffff !important;
        color: #0f172a !important;
      }
      .md-preview pre,
      .md-preview table,
      .md-preview blockquote,
      .md-preview .katex-display,
      .md-mermaid {
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .md-preview pre,
      .md-preview table,
      .md-preview .katex-display,
      .md-mermaid {
        max-width: 100% !important;
        overflow: visible !important;
      }
      .md-mermaid svg {
        width: 100% !important;
        height: auto !important;
      }
    </style>
  </head>
  <body>${previewElement.outerHTML}</body>
</html>`)
  printWindow.document.close()
  printWindow.document.title = fileName
  window.setTimeout(() => {
    printWindow.focus()
    printWindow.print()
  }, 500)
}

function markdownPdfName(doc: Document): string {
  const raw = doc.metadata.title || 'markdown-preview'
  const base = raw
    .replace(/\.(md|markdown)$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim() || 'markdown-preview'
  return `${base}.pdf`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

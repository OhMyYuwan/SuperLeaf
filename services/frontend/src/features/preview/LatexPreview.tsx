/**
 * LatexPreview — shows the compiled PDF for the current LaTeX project.
 *
 * Uses react-pdf (PDF.js) to render pages. Each successful compile bumps
 * `pdfVersion` in the compile store; we key the Document on it so the PDF
 * reloads automatically.
 *
 * Controls:
 *   - 编译 button (manual trigger)
 *   - 编译器 picker
 *   - 自动编译 toggle (debounced on content change)
 *   - Full-log toggle
 */

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import {
  Loader2,
  Play,
  RefreshCw,
  FileText,
  ChevronDown,
  ChevronUp,
  ZoomIn,
  ZoomOut,
  Download,
} from 'lucide-react'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
// Vite's `?url` import returns a hashed URL Vite serves from its dev server.
// This is the correct way to point pdfjs at its worker in a bundled app.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useCompileStore } from '../../stores/compileStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useProjectStore } from '../../stores/projectStore'
import { compileApi } from '../../services/backendApi'
import {
  sourceJumpFromPreviewText,
  type SourceJump,
} from '../../services/previewSourceMap'
import './latex-preview.css'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

interface LatexPreviewProps {
  documentId: string
  source: string
  onSourceJump?: (jump: SourceJump) => void
}

export function LatexPreview({ documentId, source, onSourceJump }: LatexPreviewProps) {
  const compilers = useCompileStore((s) => s.compilers)
  const settings = useCompileStore((s) => s.settings)
  const lastResult = useCompileStore((s) => s.lastResult)
  const compiling = useCompileStore((s) => s.compiling)
  const pdfVersion = useCompileStore((s) => s.pdfVersion)
  const autoCompile = useCompileStore((s) => s.autoCompile)
  const fullLog = useCompileStore((s) => s.fullLog)
  const loadCompilers = useCompileStore((s) => s.loadCompilers)
  const loadSettings = useCompileStore((s) => s.loadSettings)
  const updateSettings = useCompileStore((s) => s.updateSettings)
  const compile = useCompileStore((s) => s.compile)
  const loadFullLog = useCompileStore((s) => s.loadFullLog)
  const setAutoCompile = useCompileStore((s) => s.setAutoCompile)
  const saveBackendDoc = useDocumentStore((s) => s.saveBackendDoc)
  const saveStatus = useDocumentStore((s) => s.saveStatus[documentId] ?? 'idle')
  const lastSavedAt = useDocumentStore((s) => s.lastSavedAt[documentId] ?? 0)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const projectName = useProjectStore((s) =>
    s.currentProjectId
      ? s.projects.find((p) => p.id === s.currentProjectId)?.name ?? null
      : null,
  )

  const [numPages, setNumPages] = useState<number>(0)
  const [showLog, setShowLog] = useState(false)
  const [pageWidth, setPageWidth] = useState(700)
  const [zoom, setZoom] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)
  const pdfScrollRef = useRef<HTMLDivElement>(null)
  const lastAutoCompiledSavedAtRef = useRef(0)
  const lastPdfVersionRef = useRef(pdfVersion)
  const pdfScrollTopRef = useRef(0)
  const pendingPdfScrollRestoreRef = useRef<number | null>(null)

  const compileCurrentDocument = async () => {
    await saveBackendDoc(documentId)
    const docState = useDocumentStore.getState()
    if (docState.saveStatus[documentId] !== 'saved') return
    lastAutoCompiledSavedAtRef.current =
      docState.lastSavedAt[documentId] ?? lastAutoCompiledSavedAtRef.current
    await compile(documentId)
  }

  // Load compilers + settings once.
  useEffect(() => {
    loadCompilers()
    loadSettings()
  }, [loadCompilers, loadSettings])

  // Auto-compile only after the open document has been saved. This prevents
  // compile errors from creating retry loops and keeps latexmk off dirty text.
  useEffect(() => {
    if (!autoCompile) return
    if (compiling) return
    if (saveStatus !== 'saved') return
    if (!lastSavedAt || lastSavedAt === lastAutoCompiledSavedAtRef.current) return

    lastAutoCompiledSavedAtRef.current = lastSavedAt
    void compile(documentId)
  }, [autoCompile, compiling, saveStatus, lastSavedAt, documentId, compile])

  // Track container width for responsive PDF pages.
  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setPageWidth(Math.max(240, w - 24))
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  const handleCompilerChange = (compiler: string) => {
    updateSettings({ compiler })
  }

  const handlePdfDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const textElement = target.closest<HTMLElement>('.react-pdf__Page__textContent span')
    const jump = sourceJumpFromPreviewText(source, textElement?.textContent)
    if (jump) onSourceJump?.(jump)
  }

  const pdfUrl = useMemo(() => {
    if (pdfVersion <= 0 || !currentProjectId) return ''
    // Append pdfVersion as cache-buster so fresh compiles are not served stale.
    return `${compileApi.pdfUrl(currentProjectId)}?v=${pdfVersion}`
  }, [pdfVersion, currentProjectId])

  const pdfFile = useMemo(() => {
    if (!pdfUrl) return null
    // Keep this object stable across editor-state rerenders. react-pdf treats
    // a new `file` object as a new document and resets scroll to page one.
    return { url: pdfUrl, withCredentials: true } as const
  }, [pdfUrl])

  useEffect(() => {
    if (pdfVersion > 0 && lastPdfVersionRef.current > 0 && pdfVersion !== lastPdfVersionRef.current) {
      pendingPdfScrollRestoreRef.current = pdfScrollTopRef.current
    }
    lastPdfVersionRef.current = pdfVersion
  }, [pdfVersion])

  const restorePdfScrollSoon = () => {
    const target = pendingPdfScrollRestoreRef.current
    if (target == null) return

    let attempts = 0
    const restore = () => {
      const scroller = pdfScrollRef.current
      if (!scroller) return
      scroller.scrollTop = Math.min(target, Math.max(0, scroller.scrollHeight - scroller.clientHeight))
      attempts += 1
      if (attempts < 12) {
        window.setTimeout(restore, 80)
      } else {
        pendingPdfScrollRestoreRef.current = null
      }
    }
    window.requestAnimationFrame(restore)
  }

  const downloadName = useMemo(() => {
    const base = (projectName || 'document').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document'
    return `${base}.pdf`
  }, [projectName])

  const compilersAvailable = compilers?.available ?? []
  const currentCompiler = settings?.compiler || compilers?.default || ''

  return (
    <div className="latex-preview" ref={containerRef}>
      <div className="latex-preview-toolbar">
        <button
          className="primary-btn latex-compile-btn"
          onClick={() => void compileCurrentDocument()}
          disabled={compiling || compilersAvailable.length === 0}
          title="编译 (Cmd+Enter)"
        >
          {compiling ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
          {compiling ? '编译中…' : '编译'}
        </button>

        {compilersAvailable.length > 0 && (
          <select
            className="compiler-picker"
            value={currentCompiler}
            onChange={(e) => handleCompilerChange(e.target.value)}
            disabled={compiling}
            title="编译器"
          >
            {compilersAvailable.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}

        <label className="auto-compile-toggle" title="保存后自动编译">
          <input
            type="checkbox"
            checked={autoCompile}
            onChange={(e) => setAutoCompile(e.target.checked)}
          />
          <span>自动</span>
        </label>

        <a
          className={`small-btn latex-preview-download${pdfUrl ? '' : ' is-disabled'}`}
          href={pdfUrl || undefined}
          download={downloadName}
          aria-disabled={!pdfUrl}
          title={pdfUrl ? `下载 ${downloadName}` : '尚未编译'}
          onClick={(e) => {
            if (!pdfUrl) e.preventDefault()
          }}
        >
          <Download size={12} />
        </a>

        <div className="latex-preview-zoom">
          <button
            className="small-btn"
            onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}
            title="缩小"
          >
            <ZoomOut size={12} />
          </button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button
            className="small-btn"
            onClick={() => setZoom((z) => Math.min(2.5, z + 0.1))}
            title="放大"
          >
            <ZoomIn size={12} />
          </button>
        </div>
      </div>

      {compilersAvailable.length === 0 && (
        <div className="latex-preview-empty-compilers">
          <p>未检测到 LaTeX 编译器。</p>
          <p>安装 MacTeX 后点击下方重新扫描：</p>
          <code>brew install --cask mactex</code>
          <button
            className="ghost-btn small"
            onClick={() => useCompileStore.getState().rescanCompilers()}
          >
            <RefreshCw size={12} /> 重新扫描
          </button>
        </div>
      )}

      {lastResult && !lastResult.ok && (
        <div className="latex-preview-error">
          <strong>编译失败</strong>
          <div>{lastResult.error}</div>
          <button
            className="ghost-btn small"
            onClick={() => {
              setShowLog((v) => !v)
              if (!fullLog) loadFullLog()
            }}
          >
            <FileText size={12} />
            {showLog ? '收起日志' : '查看日志'}
            {showLog ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showLog && (
            <pre className="latex-preview-log">{fullLog ?? lastResult.log_tail}</pre>
          )}
        </div>
      )}

      <div
        className="latex-preview-pdf"
        ref={pdfScrollRef}
        onScroll={(event) => {
          pdfScrollTopRef.current = event.currentTarget.scrollTop
        }}
        onDoubleClick={handlePdfDoubleClick}
      >
        {!pdfUrl && !compiling && (
          <div className="latex-preview-empty">
            <p>尚未编译。点击"编译"按钮生成 PDF。</p>
          </div>
        )}
        {pdfFile && (
          <Document
            key={pdfVersion}
            file={pdfFile}
            onLoadSuccess={({ numPages }) => {
              setNumPages(numPages)
              restorePdfScrollSoon()
            }}
            onLoadError={(err) => console.error('PDF load error', err)}
            loading={<div className="latex-preview-empty">加载 PDF…</div>}
          >
            {Array.from({ length: numPages }, (_, i) => (
              <Page
                key={i}
                pageNumber={i + 1}
                width={pageWidth * zoom}
                renderTextLayer
                renderAnnotationLayer={false}
                className="latex-pdf-page"
                onRenderSuccess={restorePdfScrollSoon}
              />
            ))}
          </Document>
        )}
      </div>
    </div>
  )
}

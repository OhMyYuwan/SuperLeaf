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

import { useEffect, useMemo, useRef, useState } from 'react'
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
} from 'lucide-react'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
// Vite's `?url` import returns a hashed URL Vite serves from its dev server.
// This is the correct way to point pdfjs at its worker in a bundled app.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useCompileStore } from '../../stores/compileStore'
import { compileApi } from '../../services/backendApi'
import './latex-preview.css'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

interface LatexPreviewProps {
  documentContent: string
  documentVersion: number
}

export function LatexPreview({ documentContent, documentVersion }: LatexPreviewProps) {
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

  const [numPages, setNumPages] = useState<number>(0)
  const [showLog, setShowLog] = useState(false)
  const [pageWidth, setPageWidth] = useState(700)
  const [zoom, setZoom] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)

  // Load compilers + settings once.
  useEffect(() => {
    loadCompilers()
    loadSettings()
  }, [loadCompilers, loadSettings])

  // Auto-compile on document changes (debounced).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!autoCompile) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      compile()
    }, 2500)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentContent, documentVersion, autoCompile])

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

  const pdfUrl = useMemo(() => {
    // Append pdfVersion as cache-buster so fresh compiles are not served stale.
    return pdfVersion > 0 ? `${compileApi.pdfUrl()}?v=${pdfVersion}` : ''
  }, [pdfVersion])

  const compilersAvailable = compilers?.available ?? []
  const currentCompiler = settings?.compiler || compilers?.default || ''

  return (
    <div className="latex-preview" ref={containerRef}>
      <div className="latex-preview-toolbar">
        <button
          className="primary-btn latex-compile-btn"
          onClick={() => compile()}
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

      {lastResult && lastResult.ok && (
        <div className="latex-preview-success-bar">
          <span>
            ✓ 编译成功 · {lastResult.compiler} · {(lastResult.duration_ms / 1000).toFixed(1)}s
          </span>
          <button
            className="ghost-btn small"
            onClick={() => {
              setShowLog((v) => !v)
              if (!fullLog) loadFullLog()
            }}
          >
            <FileText size={12} />
            日志
            {showLog ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showLog && (
            <pre className="latex-preview-log">{fullLog ?? lastResult.log_tail}</pre>
          )}
        </div>
      )}

      <div className="latex-preview-pdf">
        {!pdfUrl && !compiling && (
          <div className="latex-preview-empty">
            <p>尚未编译。点击"编译"按钮生成 PDF。</p>
          </div>
        )}
        {pdfUrl && (
          <Document
            key={pdfVersion}
            file={pdfUrl}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            onLoadError={(err) => console.error('PDF load error', err)}
            loading={<div className="latex-preview-empty">加载 PDF…</div>}
          >
            {Array.from({ length: numPages }, (_, i) => (
              <Page
                key={i}
                pageNumber={i + 1}
                width={pageWidth * zoom}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                className="latex-pdf-page"
              />
            ))}
          </Document>
        )}
      </div>
    </div>
  )
}

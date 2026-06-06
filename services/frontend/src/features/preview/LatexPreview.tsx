/**
 * LatexPreview — shows the compiled PDF for the current LaTeX project.
 *
 * Uses react-pdf (PDF.js) to render pages. Each successful compile bumps
 * `pdfVersion` in the compile store; we key the Document on it so the PDF
 * reloads automatically.
 *
 * Controls:
 *   - 编译 button (manual trigger)
 *   - 编译设置 popover (compiler picker + auto-compile toggle)
 *   - Ctrl/Cmd + wheel PDF zoom
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
  StretchHorizontal,
  Settings,
} from 'lucide-react'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
// Vite's `?url` import returns a hashed URL Vite serves from its dev server.
// This is the correct way to point pdfjs at its worker in a bundled app.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useCompileStore } from '../../stores/compileStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useProjectStore } from '../../stores/projectStore'
import { compileApi, type CompileSyncToPdfResult } from '../../services/backendApi'
import {
  sourceJumpFromPreviewText,
  previewTextCandidatesNearOffset,
  type SourceJump,
} from '../../services/previewSourceMap'
import { calculateFitWidthZoom, clampPdfZoom, usePdfWheelZoom } from './usePdfWheelZoom'
import './latex-preview.css'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

interface LatexPreviewProps {
  documentId: string
  source: string
  onSourceJump?: (jump: SourceJump) => void
  syncToPdfRequest?: PdfSourceSyncRequest | null
}

export interface PdfSourceSyncRequest {
  documentId: string
  pos: number
  seq: number
}

export function LatexPreview({
  documentId,
  source,
  onSourceJump,
  syncToPdfRequest,
}: LatexPreviewProps) {
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
  const [showCompileSettings, setShowCompileSettings] = useState(false)
  const [pageWidth, setPageWidth] = useState(700)
  const [zoom, setZoom] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)
  const compileSettingsRef = useRef<HTMLDivElement>(null)
  const pdfScrollRef = useRef<HTMLDivElement>(null)
  const lastAutoCompiledSavedAtRef = useRef(0)
  const lastPdfVersionRef = useRef(pdfVersion)
  const pdfScrollTopRef = useRef(0)
  const pendingPdfScrollRestoreRef = useRef<number | null>(null)
  const pdfSyncFlashRef = useRef<HTMLElement | null>(null)
  const pdfSyncTimerRef = useRef<number | null>(null)
  const pdfSyncMarkerTimerRef = useRef<number | null>(null)
  const pdfPageSizesRef = useRef<Record<number, { width: number; height: number }>>({})
  const [pdfSyncMessage, setPdfSyncMessage] = useState<string | null>(null)
  const [pdfSyncMarker, setPdfSyncMarker] = useState<{
    page: number
    xRatio: number
    yRatio: number
  } | null>(null)

  usePdfWheelZoom({
    scrollRef: pdfScrollRef,
    zoom,
    setZoom,
  })

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

  useEffect(() => {
    if (!showCompileSettings) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!compileSettingsRef.current?.contains(target)) {
        setShowCompileSettings(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowCompileSettings(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [showCompileSettings])

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

  function showPdfSyncMessage(message: string) {
    setPdfSyncMessage(message)
    if (pdfSyncTimerRef.current != null) {
      window.clearTimeout(pdfSyncTimerRef.current)
    }
    pdfSyncTimerRef.current = window.setTimeout(() => {
      setPdfSyncMessage(null)
      pdfSyncTimerRef.current = null
    }, 2800)
  }

  function flashPdfTextMatch(target: HTMLElement) {
    if (pdfSyncFlashRef.current) {
      pdfSyncFlashRef.current.classList.remove('pdf-source-sync-flash')
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
    target.classList.add('pdf-source-sync-flash')
    pdfSyncFlashRef.current = target
    if (pdfSyncTimerRef.current != null) {
      window.clearTimeout(pdfSyncTimerRef.current)
    }
    pdfSyncTimerRef.current = window.setTimeout(() => {
      target.classList.remove('pdf-source-sync-flash')
      if (pdfSyncFlashRef.current === target) {
        pdfSyncFlashRef.current = null
      }
      pdfSyncTimerRef.current = null
    }, 1400)
  }

  function recordPdfPageSize(
    pageNumber: number,
    page: { getViewport: (options: { scale: number }) => { width: number; height: number } },
  ) {
    const viewport = page.getViewport({ scale: 1 })
    pdfPageSizesRef.current[pageNumber] = {
      width: viewport.width,
      height: viewport.height,
    }
  }

  function showPdfSyncMarker(page: number, xRatio: number, yRatio: number) {
    setPdfSyncMarker({ page, xRatio, yRatio })
    if (pdfSyncMarkerTimerRef.current != null) {
      window.clearTimeout(pdfSyncMarkerTimerRef.current)
    }
    pdfSyncMarkerTimerRef.current = window.setTimeout(() => {
      setPdfSyncMarker(null)
      pdfSyncMarkerTimerRef.current = null
    }, 1800)
  }

  function scrollToSynctexLocation(location: CompileSyncToPdfResult): boolean {
    const scroller = pdfScrollRef.current
    if (!scroller) return false

    const page = scroller.querySelector<HTMLElement>(
      `.latex-pdf-page-shell[data-page-number="${location.page}"]`,
    )
    const naturalSize = pdfPageSizesRef.current[location.page]
    if (!page || !naturalSize) return false

    const xRatio = clampRatio(location.x / naturalSize.width)
    const yRatio = clampRatio(location.y / naturalSize.height)
    const targetLeft = page.offsetLeft + xRatio * page.offsetWidth
    const targetTop = page.offsetTop + yRatio * page.offsetHeight

    scroller.scrollTo({
      left: Math.max(0, targetLeft - scroller.clientWidth / 2),
      top: Math.max(0, targetTop - scroller.clientHeight * 0.32),
      behavior: 'smooth',
    })
    showPdfSyncMarker(location.page, xRatio, yRatio)
    setPdfSyncMessage(null)
    return true
  }

  useEffect(() => {
    if (!syncToPdfRequest || syncToPdfRequest.documentId !== documentId) return

    const candidates = previewTextCandidatesNearOffset(source, syncToPdfRequest.pos)
    let cancelled = false

    const runTextFallback = () => {
      if (candidates.length === 0) {
        showPdfSyncMessage('未找到可用于定位的源码文本')
        return
      }

      let attempts = 0
      const run = () => {
        if (cancelled) return
        const scroller = pdfScrollRef.current
        if (!scroller) return
        const target = findPdfTextMatch(scroller, candidates)
        if (target) {
          flashPdfTextMatch(target)
          setPdfSyncMessage(null)
          return
        }

        attempts += 1
        if (attempts < 8) {
          window.setTimeout(run, 120)
          return
        }
        showPdfSyncMessage('未在当前 PDF 中找到对应文本，请先确认已编译最新内容')
      }

      window.requestAnimationFrame(run)
    }

    const runSynctex = async () => {
      try {
        const location = await compileApi.syncToPdf({
          document_id: syncToPdfRequest.documentId,
          offset: syncToPdfRequest.pos,
        })
        if (!cancelled && scrollToSynctexLocation(location)) {
          return
        }
      } catch {
        // Fall back to text-layer matching when SyncTeX is unavailable or stale.
      }
      if (!cancelled) {
        runTextFallback()
      }
    }

    window.requestAnimationFrame(() => {
      void runSynctex()
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncToPdfRequest?.seq])

  useEffect(() => () => {
    if (pdfSyncTimerRef.current != null) {
      window.clearTimeout(pdfSyncTimerRef.current)
    }
    if (pdfSyncMarkerTimerRef.current != null) {
      window.clearTimeout(pdfSyncMarkerTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!pdfSyncMarker) return
    const scroller = pdfScrollRef.current
    if (!scroller) return
    const page = scroller.querySelector<HTMLElement>(
      `.latex-pdf-page-shell[data-page-number="${pdfSyncMarker.page}"]`,
    )
    if (!page) return
    const targetLeft = page.offsetLeft + pdfSyncMarker.xRatio * page.offsetWidth
    const targetTop = page.offsetTop + pdfSyncMarker.yRatio * page.offsetHeight
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    if (targetLeft < scroller.scrollLeft || targetLeft > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = Math.max(0, Math.min(maxLeft, targetLeft - scroller.clientWidth / 2))
    }
    if (targetTop < scroller.scrollTop || targetTop > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, Math.min(maxTop, targetTop - scroller.clientHeight * 0.32))
    }
  }, [pageWidth, pdfSyncMarker, zoom])

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

  const setToolbarZoom = (updater: (current: number) => number) => {
    setZoom((current) => clampPdfZoom(updater(current)))
  }

  const fitPdfToWidth = () => {
    const scroller = pdfScrollRef.current
    if (!scroller) {
      setZoom(1)
      return
    }
    const style = window.getComputedStyle(scroller)
    const horizontalPadding =
      Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0')
    const viewportWidth = Math.max(0, scroller.clientWidth - horizontalPadding)
    setZoom(calculateFitWidthZoom(pageWidth, viewportWidth))
  }

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
          <Download size={18} />
        </a>

        <div className="latex-compile-settings" ref={compileSettingsRef}>
          <button
            type="button"
            className="small-btn latex-settings-btn"
            onClick={() => setShowCompileSettings((value) => !value)}
            aria-label="编译设置"
            aria-expanded={showCompileSettings}
            aria-controls="latex-compile-settings"
            title="编译设置"
          >
            <Settings size={18} strokeWidth={2} />
          </button>

          {showCompileSettings && (
            <div
              className="latex-compile-settings-popover"
              id="latex-compile-settings"
              role="group"
              aria-label="编译设置"
            >
              <label className="latex-settings-field">
                <span>编译器</span>
                {compilersAvailable.length > 0 ? (
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
                ) : (
                  <span className="latex-settings-empty">未检测到编译器</span>
                )}
              </label>

              <label className="latex-settings-toggle" title="保存后自动编译">
                <span>自动编译</span>
                <input
                  type="checkbox"
                  checked={autoCompile}
                  onChange={(e) => setAutoCompile(e.target.checked)}
                />
              </label>
            </div>
          )}
        </div>

        <div className="latex-preview-zoom">
          <button
            className="small-btn"
            onClick={() => setToolbarZoom((z) => z - 0.1)}
            aria-label="缩小 PDF"
            title="缩小"
          >
            <ZoomOut size={12} />
          </button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button
            className="small-btn"
            onClick={() => setToolbarZoom((z) => z + 0.1)}
            aria-label="放大 PDF"
            title="放大"
          >
            <ZoomIn size={12} />
          </button>
          <button
            className="small-btn"
            onClick={fitPdfToWidth}
            aria-label="适应宽度"
            title="适应宽度"
          >
            <StretchHorizontal size={12} />
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
        {pdfSyncMessage && (
          <div className="pdf-source-sync-message" role="status">
            {pdfSyncMessage}
          </div>
        )}
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
              <div
                key={i}
                className="latex-pdf-page-shell"
                data-page-number={i + 1}
              >
                <Page
                  pageNumber={i + 1}
                  width={pageWidth * clampPdfZoom(zoom)}
                  renderTextLayer
                  renderAnnotationLayer={false}
                  className="latex-pdf-page"
                  onLoadSuccess={(page) => recordPdfPageSize(i + 1, page)}
                  onRenderSuccess={restorePdfScrollSoon}
                />
                {pdfSyncMarker?.page === i + 1 && (
                  <span
                    className="pdf-source-sync-target"
                    style={{
                      left: `${pdfSyncMarker.xRatio * 100}%`,
                      top: `${pdfSyncMarker.yRatio * 100}%`,
                    }}
                    aria-hidden="true"
                  />
                )}
              </div>
            ))}
          </Document>
        )}
      </div>
    </div>
  )
}

function findPdfTextMatch(container: HTMLElement, candidates: string[]): HTMLElement | null {
  const spans = Array.from(
    container.querySelectorAll<HTMLElement>('.react-pdf__Page__textContent span'),
  )
  const normalizedCandidates = candidates
    .map((candidate) => normalizePdfLookup(candidate))
    .filter((candidate) => candidate.length >= 3)

  for (const candidate of normalizedCandidates) {
    for (const span of spans) {
      const normalizedSpan = normalizePdfLookup(span.textContent ?? '')
      if (normalizedSpan.length >= candidate.length && normalizedSpan.includes(candidate)) {
        return span
      }
    }
  }

  for (const candidate of normalizedCandidates) {
    const words = candidate.match(/[\p{L}\p{N}]{3,}/gu) ?? []
    if (words.length === 0) continue
    for (const span of spans) {
      const normalizedSpan = normalizePdfLookup(span.textContent ?? '')
      if (words.some((word) => normalizedSpan.includes(word))) {
        return span
      }
    }
  }

  return null
}

function normalizePdfLookup(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

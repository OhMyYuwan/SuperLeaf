/**
 * LatexPreview — shows the compiled PDF for the current LaTeX project.
 *
 * Uses the configured PDF previewer to render successful LaTeX compiles.
 * Each successful compile bumps `pdfVersion` in the compile store.
 *
 * Controls:
 *   - 编译 button (manual trigger)
 *   - 编译设置 popover (compiler picker + auto-compile toggle)
 *   - Ctrl/Cmd + wheel PDF zoom
 *   - Full-log toggle
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
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
import { useCompileStore } from '../../stores/compileStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useSettingsStore, type LatexPdfViewerPreference } from '../../stores/settingsStore'
import { compileApi, type CompileSyncToPdfResult } from '../../services/backendApi'
import {
  sourceJumpFromPreviewText,
  previewTextCandidatesNearOffset,
  type SourceJump,
} from '../../services/previewSourceMap'
import { calculateFitWidthZoom, clampPdfZoom, usePdfWheelZoom } from './usePdfWheelZoom'
import { pdfPointFromPageClientPosition } from './pdfCoordinate'
import { PdfJsViewer, type PdfJsViewerHandle } from './PdfJsViewer'
import type { PdfJsPagePoint } from './pdfJsWrapper'
import './latex-preview.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const DEFAULT_PDF_PAGE_ASPECT_RATIO = 792 / 612
const PDF_INTERSECTION_ROOT_MARGIN = '1200px 0px'
const PDF_RENDER_RADIUS = 2
const PDF_MAX_DEVICE_PIXEL_RATIO = 2
const PDF_LOAD_OPTIONS = {
  disableAutoFetch: false,
  disableStream: true,
  isEvalSupported: false,
} as const

interface PdfPageSize {
  width: number
  height: number
}

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
  const activeBuildId = useCompileStore((s) => s.activeBuildId)
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
  const latexPdfViewer = useSettingsStore((s) => s.latexPdfViewer)
  const setLatexPdfViewer = useSettingsStore((s) => s.setLatexPdfViewer)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const projectName = useProjectStore((s) =>
    s.currentProjectId
      ? s.projects.find((p) => p.id === s.currentProjectId)?.name ?? null
      : null,
  )

  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState<number>(1)
  const [showLog, setShowLog] = useState(false)
  const [showCompileSettings, setShowCompileSettings] = useState(false)
  const [pdfLoadError, setPdfLoadError] = useState<Error | null>(null)
  const [visiblePdfPages, setVisiblePdfPages] = useState<Set<number>>(() => new Set([1]))
  const [pdfPageSizes, setPdfPageSizes] = useState<Record<number, PdfPageSize>>({})
  const [pageWidth, setPageWidth] = useState(700)
  const [zoom, setZoom] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)
  const compileSettingsRef = useRef<HTMLDivElement>(null)
  const pdfScrollRef = useRef<HTMLDivElement>(null)
  const pdfJsViewerRef = useRef<PdfJsViewerHandle | null>(null)
  const lastAutoCompiledSavedAtRef = useRef(0)
  const lastPdfVersionRef = useRef(pdfVersion)
  const pdfScrollTopRef = useRef(0)
  const pendingPdfScrollRestoreRef = useRef<number | null>(null)
  const pdfSyncFlashRef = useRef<HTMLElement | null>(null)
  const pdfSyncTimerRef = useRef<number | null>(null)
  const pdfSyncMarkerTimerRef = useRef<number | null>(null)
  const pdfPageSizesRef = useRef<Record<number, PdfPageSize>>({})
  const pdfPageShellRefs = useRef<Record<number, HTMLDivElement | null>>({})
  // Auto-compile debounce timers (Overleaf-style: debounce + max-wait).
  const autoCompileTimerRef = useRef<number | null>(null)
  const autoCompileMaxWaitTimerRef = useRef<number | null>(null)
  const AUTO_COMPILE_DEBOUNCE_MS = 2500
  const AUTO_COMPILE_MAX_WAIT_MS = 5000
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

  const activePdfViewer = pdfLoadError ? 'native' : latexPdfViewer

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

  // Auto-compile with debounce + max-wait (Overleaf pattern).
  // Resets the debounce timer on each save; fires at most after MAX_WAIT.
  const clearAutoCompileTimers = () => {
    if (autoCompileTimerRef.current != null) {
      window.clearTimeout(autoCompileTimerRef.current)
      autoCompileTimerRef.current = null
    }
    if (autoCompileMaxWaitTimerRef.current != null) {
      window.clearTimeout(autoCompileMaxWaitTimerRef.current)
      autoCompileMaxWaitTimerRef.current = null
    }
  }

  useEffect(() => {
    if (!autoCompile) {
      clearAutoCompileTimers()
      return
    }
    if (compiling) return
    if (saveStatus !== 'saved') return
    if (!lastSavedAt || lastSavedAt === lastAutoCompiledSavedAtRef.current) return

    // Clear previous debounce timer but keep max-wait running.
    if (autoCompileTimerRef.current != null) {
      window.clearTimeout(autoCompileTimerRef.current)
    }

    const run = () => {
      clearAutoCompileTimers()
      lastAutoCompiledSavedAtRef.current = lastSavedAt
      void compile(documentId, { isAutoCompile: true })
    }

    autoCompileTimerRef.current = window.setTimeout(run, AUTO_COMPILE_DEBOUNCE_MS)
    // Max-wait: fire even if user keeps typing.
    if (autoCompileMaxWaitTimerRef.current == null) {
      autoCompileMaxWaitTimerRef.current = window.setTimeout(run, AUTO_COMPILE_MAX_WAIT_MS)
    }

    return clearAutoCompileTimers
  }, [autoCompile, compiling, saveStatus, lastSavedAt, documentId, compile])

  // Disable auto-compile on backoff to prevent retry loops.
  useEffect(() => {
    if (lastResult?.status === 'autocompile-backoff') {
      setAutoCompile(false)
    }
  }, [lastResult?.status, setAutoCompile])

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
    if (activePdfViewer === 'pdfjs-viewer') return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    void jumpFromPdfDoubleClick(target, event.clientX, event.clientY)
  }

  async function jumpFromPdfDoubleClick(target: HTMLElement, clientX: number, clientY: number) {
    const pageShell = target.closest<HTMLElement>('.latex-pdf-page-shell')
    const pageNumber = Number.parseInt(pageShell?.dataset.pageNumber ?? '', 10)
    const naturalSize = Number.isFinite(pageNumber) ? pdfPageSizesRef.current[pageNumber] : null

    if (pageShell && naturalSize && Number.isFinite(pageNumber)) {
      const point = pdfPointFromPageClientPosition({
        pageNumber,
        clientX,
        clientY,
        pageRect: pageShell.getBoundingClientRect(),
        naturalSize,
      })
      if (point) {
        try {
          const location = await compileApi.syncFromPdf(point)
          onSourceJump?.({
            documentId: location.document_id,
            pos: location.offset,
          })
          setPdfSyncMessage(null)
          return
        } catch {
          // Fall back to text-layer matching when reverse SyncTeX is unavailable or stale.
        }
      }
    }

    const textElement = target.closest<HTMLElement>('.react-pdf__Page__textContent span')
    const jump = sourceJumpFromPreviewText(source, textElement?.textContent)
    if (jump) {
      onSourceJump?.(jump)
    } else {
      showPdfSyncMessage('未找到对应源码位置，请先确认已编译最新内容')
    }
  }

  async function jumpFromPdfJsDoubleClick(point: PdfJsPagePoint, text?: string) {
    try {
      const location = await compileApi.syncFromPdf(point)
      onSourceJump?.({
        documentId: location.document_id,
        pos: location.offset,
      })
      setPdfSyncMessage(null)
      return
    } catch {
      // Fall back to text-layer matching when reverse SyncTeX is unavailable or stale.
    }

    const jump = sourceJumpFromPreviewText(source, text)
    if (jump) {
      onSourceJump?.(jump)
    } else {
      showPdfSyncMessage('未找到对应源码位置，请先确认已编译最新内容')
    }
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
    const nextSize = {
      width: viewport.width,
      height: viewport.height,
    }
    pdfPageSizesRef.current[pageNumber] = nextSize
    setPdfPageSizes((sizes) => {
      const existing = sizes[pageNumber]
      if (existing?.width === nextSize.width && existing.height === nextSize.height) return sizes
      return { ...sizes, [pageNumber]: nextSize }
    })
  }

  function getPdfPageShellStyle(pageNumber: number): CSSProperties {
    const width = pageWidth * clampPdfZoom(zoom)
    const naturalSize = pdfPageSizes[pageNumber]
    const aspectRatio = naturalSize
      ? naturalSize.height / Math.max(1, naturalSize.width)
      : DEFAULT_PDF_PAGE_ASPECT_RATIO

    return {
      width,
      minHeight: width * aspectRatio,
    }
  }

  function shouldKeepPdfPageRendered(pageNumber: number): boolean {
    return (
      visiblePdfPages.has(pageNumber) ||
      Math.abs(pageNumber - currentPage) <= PDF_RENDER_RADIUS ||
      pdfSyncMarker?.page === pageNumber
    )
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
    if (activePdfViewer === 'pdfjs-viewer') {
      const target = pdfJsViewerRef.current?.scrollToPdfLocation(location)
      if (!target) return false
      showPdfSyncMarker(location.page, target.xRatio, target.yRatio)
      setPdfSyncMessage(null)
      return true
    }

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

  function updateCurrentPdfPage(scroller: HTMLElement) {
    const pages = Array.from(scroller.querySelectorAll<HTMLElement>('.latex-pdf-page-shell'))
    if (pages.length === 0) return

    const viewportTop = scroller.getBoundingClientRect().top
    const anchorY = viewportTop + Math.min(96, scroller.clientHeight * 0.3)
    let bestPage = 1
    let bestDistance = Number.POSITIVE_INFINITY

    for (const page of pages) {
      const rect = page.getBoundingClientRect()
      const distance = Math.abs(rect.top - anchorY)
      const pageNumber = Number.parseInt(page.dataset.pageNumber ?? '', 10)
      if (Number.isFinite(pageNumber) && distance < bestDistance) {
        bestDistance = distance
        bestPage = pageNumber
      }
    }

    setCurrentPage((page) => (page === bestPage ? page : bestPage))
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
    if (activePdfViewer !== 'react-pdf') return
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
  }, [activePdfViewer, pageWidth, pdfSyncMarker, zoom])

  const pdfUrl = useMemo(() => {
    if (pdfVersion <= 0 || !currentProjectId) return ''
    // Use activeBuildId as primary identity; fall back to pdfVersion.
    const cacheKey = activeBuildId || `v${pdfVersion}`
    return `${compileApi.pdfUrl(currentProjectId)}?build=${encodeURIComponent(cacheKey)}`
  }, [pdfVersion, activeBuildId, currentProjectId])

  const pdfFile = useMemo(() => {
    if (!pdfUrl) return null
    // Keep this object stable across editor-state rerenders. react-pdf treats
    // a new `file` object as a new document and resets scroll to page one.
    return { url: pdfUrl, withCredentials: true } as const
  }, [pdfUrl])

  useEffect(() => {
    // The PDF URL is the document identity here; reset viewer state together so
    // a previous load error or page count cannot leak into the next compile.
    /* eslint-disable react-hooks/set-state-in-effect */
    setPdfLoadError(null)
    setNumPages(0)
    setCurrentPage(1)
    setVisiblePdfPages(new Set([1]))
    setPdfPageSizes({})
    /* eslint-enable react-hooks/set-state-in-effect */
    pdfPageSizesRef.current = {}
    pdfPageShellRefs.current = {}
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
  const nativePdfUrl = useMemo(() => {
    if (!pdfUrl) return ''
    return `${pdfUrl}#toolbar=0&navpanes=0&scrollbar=1`
  }, [pdfUrl])

  useEffect(() => {
    if (activePdfViewer !== 'react-pdf' || numPages <= 0) return
    const scroller = pdfScrollRef.current
    if (!scroller || !('IntersectionObserver' in window)) {
      setVisiblePdfPages(new Set([1]))
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePdfPages((pages) => {
          const next = new Set(pages)
          for (const entry of entries) {
            const pageNumber = Number.parseInt(
              (entry.target as HTMLElement).dataset.pageNumber ?? '',
              10,
            )
            if (!Number.isFinite(pageNumber)) continue
            if (entry.isIntersecting) {
              next.add(pageNumber)
            } else if (
              next.size > 1 &&
              Math.abs(pageNumber - currentPage) > PDF_RENDER_RADIUS &&
              pdfSyncMarker?.page !== pageNumber
            ) {
              next.delete(pageNumber)
            }
          }
          if (next.size === 0) next.add(Math.max(1, Math.min(currentPage, numPages)))
          return setsAreEqual(pages, next) ? pages : next
        })
      },
      {
        root: scroller,
        rootMargin: PDF_INTERSECTION_ROOT_MARGIN,
        threshold: 0.01,
      },
    )

    for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
      const shell = pdfPageShellRefs.current[pageNumber]
      if (shell) observer.observe(shell)
    }

    return () => observer.disconnect()
  }, [activePdfViewer, currentPage, numPages, pdfSyncMarker?.page, pdfVersion])

  const setToolbarZoom = (updater: (current: number) => number) => {
    setZoom((current) => clampPdfZoom(updater(current)))
  }

  const fitPdfToWidth = () => {
    if (activePdfViewer === 'pdfjs-viewer') {
      pdfJsViewerRef.current?.setScaleValue('page-width')
      return
    }

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
          download={pdfUrl ? downloadName : undefined}
          aria-disabled={!pdfUrl}
          aria-label={pdfUrl ? `下载 ${downloadName}` : '尚未编译'}
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

              <label className="latex-settings-toggle" title="复用 LaTeX 辅助文件缓存">
                <span>增量编译</span>
                <input
                  type="checkbox"
                  checked={settings?.incremental_compile ?? false}
                  onChange={(e) => updateSettings({ incremental_compile: e.target.checked })}
                  disabled={compiling}
                />
              </label>

              <button
                type="button"
                className="ghost-btn small"
                disabled={compiling}
                onClick={() => {
                  void (async () => {
                    await useCompileStore.getState().clearCache()
                    await compile(documentId, { fromScratch: true })
                  })()
                }}
              >
                <RefreshCw size={12} />
                从头编译
              </button>

              <label className="latex-settings-field">
                <span>预览器</span>
                <select
                  className="compiler-picker"
                  value={latexPdfViewer}
                  onChange={(e) =>
                    setLatexPdfViewer(e.target.value as LatexPdfViewerPreference)
                  }
                  title="PDF 预览器"
                >
                  <option value="react-pdf">react-pdf</option>
                  <option value="pdfjs-viewer">PDF.js Viewer</option>
                </select>
              </label>
            </div>
          )}
        </div>

        <div className="latex-preview-zoom">
          <span className="latex-page-indicator" title="当前页 / 总页数">
            {numPages > 0 ? `${currentPage} / ${numPages} 页` : '— / — 页'}
          </span>
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
          updateCurrentPdfPage(event.currentTarget)
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
        {pdfUrl && activePdfViewer === 'native' && (
          <iframe
            key={`native-${pdfUrl}`}
            className="latex-preview-native-pdf"
            title={downloadName}
            src={nativePdfUrl}
          />
        )}
        {pdfFile && activePdfViewer === 'react-pdf' && (
          <Document
            key={activeBuildId || pdfVersion}
            file={pdfFile}
            options={PDF_LOAD_OPTIONS}
            onLoadSuccess={({ numPages }) => {
              setPdfLoadError(null)
              setNumPages(numPages)
              setCurrentPage(numPages > 0 ? 1 : 0)
              setVisiblePdfPages(new Set([1]))
              restorePdfScrollSoon()
              window.requestAnimationFrame(() => {
                if (pdfScrollRef.current) {
                  updateCurrentPdfPage(pdfScrollRef.current)
                }
              })
            }}
            onLoadError={(err) => {
              const msg = String(err)
              if (msg.includes('Worker was destroyed') || msg.includes('Transport destroyed')) return
              console.error('PDF load error', err)
              setPdfLoadError(err instanceof Error ? err : new Error(String(err)))
            }}
            loading={<div className="latex-preview-empty">加载 PDF…</div>}
          >
            {Array.from({ length: numPages }, (_, i) => {
              const pageNumber = i + 1
              const shouldRenderPage = shouldKeepPdfPageRendered(pageNumber)

              return (
                <div
                  key={pageNumber}
                  ref={(node) => {
                    pdfPageShellRefs.current[pageNumber] = node
                  }}
                  className="latex-pdf-page-shell"
                  data-page-number={pageNumber}
                  style={getPdfPageShellStyle(pageNumber)}
                >
                  {shouldRenderPage ? (
                    <Page
                      pageNumber={pageNumber}
                      width={pageWidth * clampPdfZoom(zoom)}
                      renderTextLayer
                      renderAnnotationLayer={false}
                      canvasBackground="white"
                      className="latex-pdf-page"
                      devicePixelRatio={getPdfDevicePixelRatio()}
                      loading={<div className="latex-pdf-page-placeholder" />}
                      onLoadSuccess={(page) => recordPdfPageSize(pageNumber, page)}
                      onRenderSuccess={restorePdfScrollSoon}
                    />
                  ) : (
                    <div className="latex-pdf-page-placeholder" aria-hidden="true" />
                  )}
                  {pdfSyncMarker?.page === pageNumber && (
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
              )
            })}
          </Document>
        )}
        {pdfUrl && activePdfViewer === 'pdfjs-viewer' && (
          <PdfJsViewer
            ref={pdfJsViewerRef}
            url={pdfUrl}
            buildId={activeBuildId}
            zoom={zoom}
            syncMarker={pdfSyncMarker}
            onPagesInit={(pagesCount) => {
              setPdfLoadError(null)
              setNumPages(pagesCount)
              setCurrentPage(pagesCount > 0 ? 1 : 0)
              setVisiblePdfPages(new Set([1]))
              restorePdfScrollSoon()
            }}
            onPageChanging={(pageNumber) => setCurrentPage(pageNumber)}
            onPageRendered={restorePdfScrollSoon}
            onScaleChanging={(scale) => setZoom(clampPdfZoom(scale))}
            onPdfDoubleClick={(point, text) => {
              void jumpFromPdfJsDoubleClick(point, text)
            }}
            onLoadError={(error) => {
              // Suppress transient errors during preview mode switches where
              // the shared PDF.js worker/transport is terminated mid-render.
              const msg = String(error)
              if (msg.includes('Worker was destroyed') || msg.includes('Transport destroyed')) return
              console.error('PDF load error', error)
              setPdfLoadError(error)
            }}
          />
        )}
      </div>
    </div>
  )
}

function findPdfTextMatch(container: HTMLElement, candidates: string[]): HTMLElement | null {
  const spans = Array.from(
    container.querySelectorAll<HTMLElement>('.react-pdf__Page__textContent span, .textLayer span'),
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

function getPdfDevicePixelRatio(): number {
  if (typeof window === 'undefined') return 1
  const ratio = window.devicePixelRatio || 1
  return Math.max(1, Math.min(PDF_MAX_DEVICE_PIXEL_RATIO, ratio))
}

function setsAreEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

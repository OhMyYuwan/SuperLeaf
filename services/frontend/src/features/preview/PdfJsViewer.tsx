/**
 * PdfJsViewer — React shell for the PDF.js PDFViewer wrapper.
 *
 * Renders the container DOM, delegates lifecycle to PdfJsWrapper,
 * and exposes page events back to the parent.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type MouseEvent,
} from 'react'
import {
  PdfJsWrapper,
  type PdfJsPagePoint,
  type PdfJsScrollResult,
  type PdfJsSyncMarker,
} from './pdfJsWrapper'

export interface PdfJsViewerHandle {
  scrollToPdfLocation: (location: PdfJsPagePoint) => PdfJsScrollResult | null
  setScaleValue: (scale: number | 'page-width' | 'auto') => void
  scrollToPage: (pageNumber: number) => void
  getCurrentPage: () => number
  getPagesCount: () => number
}

interface PdfJsViewerProps {
  url: string
  buildId: string
  zoom: number
  syncMarker: PdfJsSyncMarker | null
  onPagesInit: (pagesCount: number) => void
  onPageChanging: (pageNumber: number) => void
  onPageRendered: (pageNumber: number) => void
  onScaleChanging: (scale: number) => void
  onPdfDoubleClick: (point: PdfJsPagePoint, text?: string) => void
  onLoadError: (error: Error) => void
}

export const PdfJsViewer = forwardRef<PdfJsViewerHandle, PdfJsViewerProps>(function PdfJsViewer({
  url,
  buildId,
  zoom,
  syncMarker,
  onPagesInit,
  onPageChanging,
  onPageRendered,
  onScaleChanging,
  onPdfDoubleClick,
  onLoadError,
}: PdfJsViewerProps, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<PdfJsWrapper | null>(null)
  const callbacksRef = useRef({
    onPagesInit,
    onPageChanging,
    onPageRendered,
    onScaleChanging,
    onLoadError,
  })

  callbacksRef.current = {
    onPagesInit,
    onPageChanging,
    onPageRendered,
    onScaleChanging,
    onLoadError,
  }

  useImperativeHandle(ref, () => ({
    scrollToPdfLocation: (location) => wrapperRef.current?.scrollToPdfLocation(location) ?? null,
    setScaleValue: (scale) => wrapperRef.current?.setScaleValue(scale),
    scrollToPage: (pageNumber) => wrapperRef.current?.scrollToPage(pageNumber),
    getCurrentPage: () => wrapperRef.current?.getCurrentPage() ?? 0,
    getPagesCount: () => wrapperRef.current?.getPagesCount() ?? 0,
  }), [])

  // Initialize the wrapper once on mount.
  useEffect(() => {
    if (!containerRef.current || !viewerRef.current) return
    const wrapper = new PdfJsWrapper({
      container: containerRef.current,
      viewer: viewerRef.current,
      onPagesInit: (pagesCount) => callbacksRef.current.onPagesInit(pagesCount),
      onPageChanging: (pageNumber) => callbacksRef.current.onPageChanging(pageNumber),
      onPageRendered: (pageNumber) => callbacksRef.current.onPageRendered(pageNumber),
      onScaleChanging: (scale) => callbacksRef.current.onScaleChanging(scale),
    })
    wrapperRef.current = wrapper
    return () => {
      wrapper.destroy()
      wrapperRef.current = null
    }
  }, [])

  // Load a new PDF when url or buildId changes.
  // Preserve current page across recompiles so the viewer doesn't jump to page 1.
  useEffect(() => {
    if (!wrapperRef.current || !url) return
    const wrapper = wrapperRef.current
    const savedPage = wrapper.getCurrentPage()
    wrapper.load(url).then(() => {
      // Restore the page position after the new PDF is loaded.
      if (savedPage > 1) {
        wrapper.scrollToPage(savedPage)
      }
    }).catch((error: unknown) => {
      callbacksRef.current.onLoadError(error instanceof Error ? error : new Error(String(error)))
    })
  }, [url, buildId])

  // Sync zoom level.
  useEffect(() => {
    wrapperRef.current?.setScale(zoom)
  }, [zoom])

  useEffect(() => {
    if (!containerRef.current || !wrapperRef.current || !('ResizeObserver' in window)) return
    const observer = new ResizeObserver(() => {
      wrapperRef.current?.updateOnResize()
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null

    const applyMarker = (attempts: number) => {
      if (cancelled) return
      const wrapper = wrapperRef.current
      if (!wrapper) return

      if (!syncMarker) {
        wrapper.clearSyncMarker()
        return
      }

      const rendered = wrapper.showSyncMarker(syncMarker)
      if (!rendered && attempts < 10) {
        timer = window.setTimeout(() => applyMarker(attempts + 1), 100)
      }
    }

    applyMarker(0)
    return () => {
      cancelled = true
      if (timer != null) {
        window.clearTimeout(timer)
      }
    }
  }, [syncMarker])

  const handleDoubleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const point = wrapperRef.current?.pdfPointFromClientPosition(event.clientX, event.clientY)
      if (!point) return
      const target = event.target
      const text =
        target instanceof HTMLElement
          ? (target.closest<HTMLElement>('.textLayer span')?.textContent ?? undefined)
          : undefined
      onPdfDoubleClick(point, text)
    },
    [onPdfDoubleClick],
  )

  return (
    <div className="latex-pdfjs-outer">
      <div className="latex-pdfjs-container" ref={containerRef} onDoubleClick={handleDoubleClick}>
        <div className="pdfViewer removePageBorders" ref={viewerRef} />
      </div>
    </div>
  )
})

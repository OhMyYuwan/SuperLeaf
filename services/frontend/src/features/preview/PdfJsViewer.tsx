/**
 * PdfJsViewer — React shell for the PDF.js PDFViewer wrapper.
 *
 * Renders the container DOM, delegates lifecycle to PdfJsWrapper,
 * and exposes page events back to the parent.
 */

import { useEffect, useRef } from 'react'
import { PdfJsWrapper } from './pdfJsWrapper'

interface PdfJsViewerProps {
  url: string
  buildId: string
  zoom: number
  onPagesInit: (pagesCount: number) => void
  onPageChanging: (pageNumber: number) => void
  onPageRendered: (pageNumber: number) => void
  onLoadError: (error: Error) => void
}

export function PdfJsViewer({
  url,
  buildId,
  zoom,
  onPagesInit,
  onPageChanging,
  onPageRendered,
  onLoadError,
}: PdfJsViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<PdfJsWrapper | null>(null)

  // Initialize the wrapper once on mount.
  useEffect(() => {
    if (!containerRef.current || !viewerRef.current) return
    const wrapper = new PdfJsWrapper({
      container: containerRef.current,
      viewer: viewerRef.current,
      onPagesInit,
      onPageChanging,
      onPageRendered,
    })
    wrapperRef.current = wrapper
    return () => {
      wrapper.destroy()
      wrapperRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load a new PDF when url or buildId changes.
  useEffect(() => {
    if (!wrapperRef.current || !url) return
    wrapperRef.current.load(url).catch((error: unknown) => {
      onLoadError(error instanceof Error ? error : new Error(String(error)))
    })
  }, [url, buildId, onLoadError])

  // Sync zoom level.
  useEffect(() => {
    wrapperRef.current?.setScale(zoom)
  }, [zoom])

  return (
    <div className="latex-pdfjs-container" ref={containerRef}>
      <div className="pdfViewer" ref={viewerRef} />
    </div>
  )
}

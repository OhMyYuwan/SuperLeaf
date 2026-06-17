/**
 * pdfJsWrapper — Direct PDF.js PDFViewer wrapper.
 *
 * Bypasses react-pdf to get full control over lazy rendering, page lifecycle,
 * and scroll-driven page changing. Uses PDF.js EventBus + PDFViewer directly.
 */

import {
  EventBus,
  PDFLinkService,
  PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs'
import * as pdfjsLib from 'pdfjs-dist'
import 'pdfjs-dist/web/pdf_viewer.css'

export interface PdfJsPagePoint {
  page: number
  x: number
  y: number
}

export interface PdfJsSyncMarker {
  page: number
  xRatio: number
  yRatio: number
}

export interface PdfJsScrollResult {
  xRatio: number
  yRatio: number
}

interface PdfJsPageSize {
  width: number
  height: number
}

export interface PdfJsWrapperOptions {
  container: HTMLDivElement
  viewer: HTMLDivElement
  onPagesInit?: (pagesCount: number) => void
  onPageChanging?: (pageNumber: number) => void
  onPageRendered?: (pageNumber: number) => void
  onScaleChanging?: (scale: number) => void
}

export class PdfJsWrapper {
  private eventBus = new EventBus()
  private linkService: PDFLinkService
  private viewer: PDFViewer
  private loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null
  private activeUrl = ''
  private syncMarkerElement: HTMLSpanElement | null = null

  constructor(options: PdfJsWrapperOptions) {
    this.linkService = new PDFLinkService({ eventBus: this.eventBus })
    this.viewer = new PDFViewer({
      container: options.container,
      viewer: options.viewer,
      eventBus: this.eventBus,
      linkService: this.linkService,
      annotationMode: 1,
      maxCanvasPixels: 8192 * 8192,
    })
    this.linkService.setViewer(this.viewer)

    this.eventBus.on('pagesinit', () => {
      options.onPagesInit?.(this.viewer.pagesCount)
      this.updateSoon()
    })
    this.eventBus.on('pagechanging', (event: { pageNumber: number }) => {
      options.onPageChanging?.(event.pageNumber)
    })
    this.eventBus.on('pagerendered', (event: { pageNumber: number }) => {
      options.onPageRendered?.(event.pageNumber)
    })
    this.eventBus.on('scalechanging', (event: { scale: number }) => {
      if (Number.isFinite(event.scale)) {
        options.onScaleChanging?.(event.scale)
      }
    })
  }

  async load(url: string): Promise<void> {
    if (this.activeUrl === url && this.viewer.pdfDocument) {
      this.updateSoon()
      return
    }

    this.activeUrl = url
    this.loadingTask?.destroy()

    // Priority page loading: PDF.js fetches only the data needed for the
    // current viewport, then progressively loads other pages on scroll.
    // This is the key advantage over react-pdf (which loads everything upfront).
    // Trade-off: JPEG2000 images may fail to decode (known PDF.js limitation),
    // but large PDFs load much faster for the common case.
    const loadingTask = pdfjsLib.getDocument({
      url,
      withCredentials: true,
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
      enableXfa: false,
      rangeChunkSize: 128 * 1024,
    })
    this.loadingTask = loadingTask

    try {
      const pdf = await loadingTask.promise
      if (this.activeUrl !== url) {
        await pdf.destroy()
        return
      }
      this.viewer.setDocument(pdf)
      this.linkService.setDocument(pdf, null)
      this.updateSoon()
    } catch (err: unknown) {
      // Suppress transient errors during mode switches where the shared
      // PDF.js worker/transport is terminated mid-render.
      const errorName = err instanceof Error ? err.name : ''
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (errorName === 'AbortError' || errorMessage.includes('Worker was destroyed') || errorMessage.includes('Transport destroyed')) {
        return
      }
      throw err
    }
  }

  setScale(scale: number | 'page-width' | 'auto'): void {
    this.setScaleValue(scale)
  }

  setScaleValue(scale: number | 'page-width' | 'auto'): void {
    this.viewer.currentScaleValue = String(scale)
  }

  scrollToPage(pageNumber: number): void {
    if (!Number.isFinite(pageNumber) || pageNumber < 1) return
    const targetPage = Math.min(Math.max(1, Math.round(pageNumber)), this.viewer.pagesCount || 1)
    this.viewer.scrollPageIntoView({ pageNumber: targetPage })
    this.viewer.currentPageNumber = targetPage
  }

  getCurrentPage(): number {
    return this.viewer.currentPageNumber
  }

  getPagesCount(): number {
    return this.viewer.pagesCount
  }

  getCurrentScale(): number {
    return this.viewer.currentScale
  }

  scrollToPdfLocation(location: PdfJsPagePoint): PdfJsScrollResult | null {
    const page = this.getPageElement(location.page)
    const size = this.getPageSize(location.page)
    if (!page || !size) return null

    const xRatio = clampRatio(location.x / size.width)
    const yRatio = clampRatio(location.y / size.height)
    const targetLeft = page.offsetLeft + xRatio * page.offsetWidth
    const targetTop = page.offsetTop + yRatio * page.offsetHeight

    this.viewer.container.scrollTo({
      left: Math.max(0, targetLeft - this.viewer.container.clientWidth / 2),
      top: Math.max(0, targetTop - this.viewer.container.clientHeight * 0.32),
      behavior: 'smooth',
    })
    this.viewer.currentPageNumber = location.page

    return { xRatio, yRatio }
  }

  pdfPointFromClientPosition(clientX: number, clientY: number): PdfJsPagePoint | null {
    const target = this.viewer.container.ownerDocument.elementFromPoint(clientX, clientY)
    const page = target instanceof HTMLElement ? target.closest<HTMLElement>('.page') : null
    const pageNumber = Number.parseInt(page?.dataset.pageNumber ?? '', 10)
    const size = Number.isFinite(pageNumber) ? this.getPageSize(pageNumber) : null
    if (!page || !size) return null

    const rect = page.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null

    return {
      page: pageNumber,
      x: clampRatio((clientX - rect.left) / rect.width) * size.width,
      y: clampRatio((clientY - rect.top) / rect.height) * size.height,
    }
  }

  showSyncMarker(marker: PdfJsSyncMarker): boolean {
    this.clearSyncMarker()

    const page = this.getPageElement(marker.page)
    if (!page) return false

    const element = page.ownerDocument.createElement('span')
    element.className = 'pdf-source-sync-target'
    element.style.left = `${marker.xRatio * 100}%`
    element.style.top = `${marker.yRatio * 100}%`
    element.setAttribute('aria-hidden', 'true')
    page.appendChild(element)
    this.syncMarkerElement = element
    return true
  }

  clearSyncMarker(): void {
    this.syncMarkerElement?.remove()
    this.syncMarkerElement = null
  }

  updateOnResize(): void {
    this.updateSoon()
  }

  private updateSoon(): void {
    window.requestAnimationFrame(() => {
      this.viewer.update()
    })
  }

  destroy(): void {
    this.activeUrl = ''
    this.clearSyncMarker()
    this.loadingTask?.destroy()
    this.viewer.setDocument(null as unknown as Parameters<PDFViewer['setDocument']>[0])
    this.linkService.setDocument(null, null)
  }

  private getPageElement(pageNumber: number): HTMLElement | null {
    const pageView = this.viewer.getPageView(pageNumber - 1) as { div?: HTMLElement } | null
    return (
      pageView?.div ??
      this.viewer.container.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`)
    )
  }

  private getPageSize(pageNumber: number): PdfJsPageSize | null {
    const pageView = this.viewer.getPageView(pageNumber - 1) as
      | { viewport?: { viewBox?: number[] } }
      | null
    const viewBox = pageView?.viewport?.viewBox
    if (!viewBox || viewBox.length < 4) return null

    const width = Math.abs(viewBox[2] - viewBox[0])
    const height = Math.abs(viewBox[3] - viewBox[1])
    if (width <= 0 || height <= 0) return null
    return { width, height }
  }
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

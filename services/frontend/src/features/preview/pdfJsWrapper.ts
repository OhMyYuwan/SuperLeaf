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

const PDF_RANGE_CHUNK_SIZE = 128 * 1024

export interface PdfJsWrapperOptions {
  container: HTMLDivElement
  viewer: HTMLDivElement
  onPagesInit?: (pagesCount: number) => void
  onPageChanging?: (pageNumber: number) => void
  onPageRendered?: (pageNumber: number) => void
}

export class PdfJsWrapper {
  private eventBus = new EventBus()
  private linkService: PDFLinkService
  private viewer: PDFViewer
  private loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null
  private activeUrl = ''

  constructor(options: PdfJsWrapperOptions) {
    this.linkService = new PDFLinkService({ eventBus: this.eventBus })
    this.viewer = new PDFViewer({
      container: options.container,
      viewer: options.viewer,
      eventBus: this.eventBus,
      linkService: this.linkService,
      annotationMode: 1,
      maxCanvasPixels: 8192 * 8192,
    } as any)
    this.linkService.setViewer(this.viewer)

    this.eventBus.on('pagesinit', () => {
      options.onPagesInit?.(this.viewer.pagesCount)
    })
    this.eventBus.on('pagechanging', (event: { pageNumber: number }) => {
      options.onPageChanging?.(event.pageNumber)
    })
    this.eventBus.on('pagerendered', (event: { pageNumber: number }) => {
      options.onPageRendered?.(event.pageNumber)
    })
  }

  async load(url: string): Promise<void> {
    this.activeUrl = url
    this.loadingTask?.destroy()

    // Fetch the entire PDF as ArrayBuffer first.
    // JPEG2000 images require all data to be available for decoding;
    // PDF.js's partial loading (disableAutoFetch) may only fetch partial
    // JPX data, causing "OpenJPEG failed to initialize" errors.
    let data: ArrayBuffer
    try {
      const res = await fetch(url, { credentials: 'include' })
      if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`)
      data = await res.arrayBuffer()
    } catch {
      // Fetch was cancelled or network error — safe to ignore.
      return
    }

    // Guard: if a newer load was requested while we fetched, discard this one.
    if (this.activeUrl !== url) return

    const loadingTask = pdfjsLib.getDocument({
      data,
      isEvalSupported: false,
      enableXfa: false,
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
    } catch (err: any) {
      // Suppress "Worker was destroyed" — expected during mode switches
      // or component unmounts where the shared PDF.js worker is terminated.
      if (err?.name === 'AbortError' || String(err).includes('Worker was destroyed')) {
        return
      }
      throw err
    }
  }

  setScale(scale: number | 'page-width' | 'auto'): void {
    this.viewer.currentScaleValue = String(scale)
  }

  scrollToPage(pageNumber: number): void {
    this.viewer.scrollPageIntoView({ pageNumber })
  }

  destroy(): void {
    this.activeUrl = ''
    this.loadingTask?.destroy()
    this.viewer.setDocument(null as any)
    this.linkService.setDocument(null as any, null)
  }
}

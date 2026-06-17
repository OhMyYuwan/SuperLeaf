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

    const loadingTask = pdfjsLib.getDocument({
      url,
      withCredentials: true,
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
      enableXfa: false,
      rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
    })
    this.loadingTask = loadingTask

    const pdf = await loadingTask.promise
    // Guard: if a newer load was requested while we awaited, discard this one.
    if (this.activeUrl !== url) {
      await pdf.destroy()
      return
    }
    this.viewer.setDocument(pdf)
    this.linkService.setDocument(pdf, null)
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

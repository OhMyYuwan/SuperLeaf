import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'

export const PDF_ZOOM_MIN = 0.4
export const PDF_ZOOM_MAX = 2.5

const MAX_WHEEL_SCALE_FACTOR = 1.2
const WHEEL_SCALE_FACTOR_DIVISOR = 20
const WHEEL_SCROLL_IDLE_MS = 100
const PDF_PAGE_SELECTOR = '.react-pdf__Page'
const ANCHOR_CORRECTION_DELAYS_MS = [0, 50, 120, 240]
const ANCHOR_CORRECTION_EPSILON_PX = 0.5

interface WheelZoomResult {
  nextZoom: number
  scaleFactor: number
}

interface ScrollDelta {
  left: number
  top: number
}

interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

interface PdfPageAnchor {
  pageIndex: number
  pageNumber: string | null
  clientX: number
  clientY: number
  xRatio: number
  yRatio: number
}

interface UsePdfWheelZoomOptions {
  scrollRef: RefObject<HTMLElement | null>
  zoom: number
  setZoom: Dispatch<SetStateAction<number>>
}

export function clampPdfZoom(zoom: number): number {
  return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, zoom))
}

export function calculateFitWidthZoom(pageWidth: number, viewportWidth: number): number {
  if (pageWidth <= 0 || viewportWidth <= 0) return 1
  return clampPdfZoom(viewportWidth / pageWidth)
}

export function calculateWheelZoom(currentZoom: number, deltaY: number): WheelZoomResult {
  const previousZoom = clampPdfZoom(currentZoom)
  if (deltaY === 0) {
    return { nextZoom: previousZoom, scaleFactor: 1 }
  }

  const scrollMagnitude = Math.abs(deltaY)
  const scaleFactorMagnitude = Math.min(
    1 + scrollMagnitude / WHEEL_SCALE_FACTOR_DIVISOR,
    MAX_WHEEL_SCALE_FACTOR,
  )
  const scaleDirection = Math.sign(deltaY)
  const approximateScaleFactor = scaleDirection < 0
    ? scaleFactorMagnitude
    : 1 / scaleFactorMagnitude
  const nextZoom = clampPdfZoom(Math.round(previousZoom * approximateScaleFactor * 100) / 100)

  return {
    nextZoom,
    scaleFactor: nextZoom / previousZoom,
  }
}

export function scrollDeltaForZoomAnchor(
  pointerX: number,
  pointerY: number,
  scaleFactor: number,
  scrollLeft = 0,
  scrollTop = 0,
): ScrollDelta {
  return {
    left: (scrollLeft + pointerX) * (scaleFactor - 1),
    top: (scrollTop + pointerY) * (scaleFactor - 1),
  }
}

export function scrollDeltaForPageAnchor(anchor: PdfPageAnchor, pageRect: RectLike): ScrollDelta {
  const anchoredX = pageRect.left + pageRect.width * anchor.xRatio
  const anchoredY = pageRect.top + pageRect.height * anchor.yRatio
  return {
    left: anchoredX - anchor.clientX,
    top: anchoredY - anchor.clientY,
  }
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function rectDistanceSquared(rect: DOMRect, clientX: number, clientY: number): number {
  const dx = clientX < rect.left
    ? rect.left - clientX
    : clientX > rect.right
      ? clientX - rect.right
      : 0
  const dy = clientY < rect.top
    ? rect.top - clientY
    : clientY > rect.bottom
      ? clientY - rect.bottom
      : 0
  return dx * dx + dy * dy
}

function findNearestPdfPage(container: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
  const pages = Array.from(container.querySelectorAll<HTMLElement>(PDF_PAGE_SELECTOR))
  let bestPage: HTMLElement | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const page of pages) {
    const rect = page.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    const distance = rectDistanceSquared(rect, clientX, clientY)
    if (distance < bestDistance) {
      bestDistance = distance
      bestPage = page
    }
  }

  return bestPage
}

function findPdfPageAtPoint(container: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
  const target = typeof document === 'undefined' ? null : document.elementFromPoint(clientX, clientY)
  const directPage = target instanceof HTMLElement
    ? target.closest<HTMLElement>(PDF_PAGE_SELECTOR)
    : null
  if (directPage && container.contains(directPage)) return directPage
  return findNearestPdfPage(container, clientX, clientY)
}

function pageIndexInContainer(container: HTMLElement, page: HTMLElement): number {
  return Array.from(container.querySelectorAll<HTMLElement>(PDF_PAGE_SELECTOR)).indexOf(page)
}

function capturePdfPageAnchor(
  container: HTMLElement,
  clientX: number,
  clientY: number,
): PdfPageAnchor | null {
  const page = findPdfPageAtPoint(container, clientX, clientY)
  if (!page) return null

  const rect = page.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null

  const pageIndex = pageIndexInContainer(container, page)
  if (pageIndex < 0) return null

  return {
    pageIndex,
    pageNumber: page.getAttribute('data-page-number'),
    clientX,
    clientY,
    xRatio: clampUnit((clientX - rect.left) / rect.width),
    yRatio: clampUnit((clientY - rect.top) / rect.height),
  }
}

function findPdfPageForAnchor(container: HTMLElement, anchor: PdfPageAnchor): HTMLElement | null {
  const pages = Array.from(container.querySelectorAll<HTMLElement>(PDF_PAGE_SELECTOR))
  if (anchor.pageNumber) {
    const pageByNumber = pages.find(
      (page) => page.getAttribute('data-page-number') === anchor.pageNumber,
    )
    if (pageByNumber) return pageByNumber
  }
  return pages[anchor.pageIndex] ?? null
}

export function usePdfWheelZoom({
  scrollRef,
  zoom,
  setZoom,
}: UsePdfWheelZoomOptions): void {
  const zoomRef = useRef(zoom)
  const isScrollingRef = useRef(false)
  const scrollIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const anchorCorrectionTimeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const anchorCorrectionFramesRef = useRef<number[]>([])

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const clearAnchorCorrections = () => {
      for (const timeout of anchorCorrectionTimeoutsRef.current) {
        clearTimeout(timeout)
      }
      for (const frame of anchorCorrectionFramesRef.current) {
        window.cancelAnimationFrame(frame)
      }
      anchorCorrectionTimeoutsRef.current = []
      anchorCorrectionFramesRef.current = []
    }

    const correctScrollToAnchor = (anchor: PdfPageAnchor) => {
      const page = findPdfPageForAnchor(container, anchor)
      if (!page) return

      const scrollDelta = scrollDeltaForPageAnchor(anchor, page.getBoundingClientRect())
      if (Math.abs(scrollDelta.left) > ANCHOR_CORRECTION_EPSILON_PX) {
        container.scrollLeft += scrollDelta.left
      }
      if (Math.abs(scrollDelta.top) > ANCHOR_CORRECTION_EPSILON_PX) {
        container.scrollTop += scrollDelta.top
      }
    }

    const scheduleAnchorCorrections = (anchor: PdfPageAnchor) => {
      clearAnchorCorrections()

      for (const delay of ANCHOR_CORRECTION_DELAYS_MS) {
        const run = () => {
          const frame = window.requestAnimationFrame(() => {
            correctScrollToAnchor(anchor)
          })
          anchorCorrectionFramesRef.current.push(frame)
        }

        if (delay === 0) {
          run()
        } else {
          const timeout = setTimeout(run, delay)
          anchorCorrectionTimeoutsRef.current.push(timeout)
        }
      }
    }

    const wheelListener = (event: WheelEvent) => {
      if ((event.metaKey || event.ctrlKey) && !isScrollingRef.current) {
        event.preventDefault()

        const previousZoom = zoomRef.current
        const { nextZoom, scaleFactor } = calculateWheelZoom(previousZoom, event.deltaY)
        if (nextZoom === previousZoom) return

        const containerRect = container.getBoundingClientRect()
        const pointerX = event.clientX - containerRect.left
        const pointerY = event.clientY - containerRect.top
        const pageAnchor = capturePdfPageAnchor(container, event.clientX, event.clientY)
        const scrollDelta = scrollDeltaForZoomAnchor(
          pointerX,
          pointerY,
          scaleFactor,
          container.scrollLeft,
          container.scrollTop,
        )

        zoomRef.current = nextZoom
        flushSync(() => setZoom(nextZoom))

        if (pageAnchor) {
          scheduleAnchorCorrections(pageAnchor)
        } else {
          clearAnchorCorrections()
          window.requestAnimationFrame(() => {
            container.scrollLeft += scrollDelta.left
            container.scrollTop += scrollDelta.top
          })
        }
        return
      }

      clearAnchorCorrections()
      isScrollingRef.current = true
      if (scrollIdleTimeoutRef.current) {
        clearTimeout(scrollIdleTimeoutRef.current)
      }
      scrollIdleTimeoutRef.current = setTimeout(() => {
        isScrollingRef.current = false
      }, WHEEL_SCROLL_IDLE_MS)
    }

    container.addEventListener('wheel', wheelListener, { passive: false })

    return () => {
      container.removeEventListener('wheel', wheelListener)
      if (scrollIdleTimeoutRef.current) clearTimeout(scrollIdleTimeoutRef.current)
      clearAnchorCorrections()
    }
  }, [scrollRef, setZoom])
}

import { describe, expect, it } from 'vitest'
import {
  calculateFitWidthZoom,
  calculateWheelZoom,
  clampPdfZoom,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  scrollDeltaForPageAnchor,
  scrollDeltaForZoomAnchor,
} from '../features/preview/usePdfWheelZoom'

describe('PDF wheel zoom calculations', () => {
  it('zooms in for upward wheel movement and caps the per-event scale factor', () => {
    const small = calculateWheelZoom(1, -1)
    const large = calculateWheelZoom(1, -1000)

    expect(small.nextZoom).toBeGreaterThan(1)
    expect(large.nextZoom).toBe(1.2)
    expect(large.scaleFactor).toBe(1.2)
  })

  it('zooms out for downward wheel movement and caps fast wheel jumps', () => {
    const result = calculateWheelZoom(1, 1000)

    expect(result.nextZoom).toBe(0.83)
    expect(result.scaleFactor).toBe(0.83)
  })

  it('clamps wheel zoom to the preview zoom limits', () => {
    expect(calculateWheelZoom(PDF_ZOOM_MAX, -1000).nextZoom).toBe(PDF_ZOOM_MAX)
    expect(calculateWheelZoom(PDF_ZOOM_MIN, 1000).nextZoom).toBe(PDF_ZOOM_MIN)
    expect(clampPdfZoom(99)).toBe(PDF_ZOOM_MAX)
    expect(clampPdfZoom(0)).toBe(PDF_ZOOM_MIN)
  })

  it('computes fit-width zoom from the PDF page width and viewport width', () => {
    expect(calculateFitWidthZoom(700, 560)).toBeCloseTo(0.8)
    expect(calculateFitWidthZoom(700, 875)).toBeCloseTo(1.25)
    expect(calculateFitWidthZoom(700, 4000)).toBe(PDF_ZOOM_MAX)
    expect(calculateFitWidthZoom(700, 20)).toBe(PDF_ZOOM_MIN)
    expect(calculateFitWidthZoom(0, 560)).toBe(1)
  })

  it('computes scroll compensation around the pointer anchor from the current viewport', () => {
    const zoomInDelta = scrollDeltaForZoomAnchor(200, 120, 1.2)
    const zoomOutDelta = scrollDeltaForZoomAnchor(200, 120, 0.8)

    expect(zoomInDelta.left).toBeCloseTo(40)
    expect(zoomInDelta.top).toBeCloseTo(24)
    expect(zoomOutDelta.left).toBeCloseTo(-40)
    expect(zoomOutDelta.top).toBeCloseTo(-24)
  })

  it('includes existing scroll offsets when preserving the mouse anchor', () => {
    const zoomInDelta = scrollDeltaForZoomAnchor(200, 120, 1.2, 60, 500)
    const zoomOutDelta = scrollDeltaForZoomAnchor(200, 120, 0.8, 60, 500)

    expect(zoomInDelta.left).toBeCloseTo(52)
    expect(zoomInDelta.top).toBeCloseTo(124)
    expect(zoomOutDelta.left).toBeCloseTo(-52)
    expect(zoomOutDelta.top).toBeCloseTo(-124)
  })

  it('computes correction from the same page-relative point after layout changes', () => {
    const delta = scrollDeltaForPageAnchor(
      {
        pageIndex: 0,
        pageNumber: '1',
        clientX: 500,
        clientY: 320,
        xRatio: 0.25,
        yRatio: 0.5,
      },
      {
        left: 410,
        top: 160,
        width: 720,
        height: 980,
      },
    )

    expect(delta.left).toBeCloseTo(90)
    expect(delta.top).toBeCloseTo(330)
  })
})

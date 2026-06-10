interface PdfPageClientPositionInput {
  pageNumber: number
  clientX: number
  clientY: number
  pageRect: {
    left: number
    top: number
    width: number
    height: number
  }
  naturalSize: {
    width: number
    height: number
  }
}

export interface PdfPagePoint {
  page: number
  x: number
  y: number
}

export function pdfPointFromPageClientPosition({
  pageNumber,
  clientX,
  clientY,
  pageRect,
  naturalSize,
}: PdfPageClientPositionInput): PdfPagePoint | null {
  if (
    pageNumber < 1 ||
    pageRect.width <= 0 ||
    pageRect.height <= 0 ||
    naturalSize.width <= 0 ||
    naturalSize.height <= 0
  ) {
    return null
  }

  const xRatio = clamp((clientX - pageRect.left) / pageRect.width)
  const yRatio = clamp((clientY - pageRect.top) / pageRect.height)
  return {
    page: pageNumber,
    x: xRatio * naturalSize.width,
    y: yRatio * naturalSize.height,
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

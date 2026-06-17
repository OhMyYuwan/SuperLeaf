import { describe, expect, it } from 'vitest'

const fsPromisesSpecifier = 'node:fs/promises'
const latexPreviewUrl = new URL('./LatexPreview.tsx', import.meta.url)
const pdfJsViewerUrl = new URL('./PdfJsViewer.tsx', import.meta.url)
const pdfJsWrapperUrl = new URL('./pdfJsWrapper.ts', import.meta.url)

async function readSource(url: URL) {
  const { readFile } = (await import(fsPromisesSpecifier)) as {
    readFile: (path: URL, encoding: 'utf8') => Promise<string>
  }
  return readFile(url, 'utf8')
}

describe('PDF.js SuperLeaf integration contract', () => {
  it('exposes imperative PDF.js navigation, SyncTeX, and scale controls', async () => {
    const viewerSource = await readSource(pdfJsViewerUrl)
    const wrapperSource = await readSource(pdfJsWrapperUrl)

    expect(viewerSource).toContain('export interface PdfJsViewerHandle')
    expect(viewerSource).toContain('forwardRef<PdfJsViewerHandle')
    expect(viewerSource).toContain('useImperativeHandle')
    expect(viewerSource).toContain('onPdfDoubleClick')
    expect(viewerSource).toContain('onScaleChanging')
    expect(viewerSource).toContain('syncMarker')

    expect(wrapperSource).toContain('scrollToPdfLocation')
    expect(wrapperSource).toContain('pdfPointFromClientPosition')
    expect(wrapperSource).toContain('setScaleValue')
    expect(wrapperSource).toContain('scrollToPage')
    expect(wrapperSource).toContain('showSyncMarker')
    expect(wrapperSource).toContain('clearSyncMarker')
  })

  it('routes LatexPreview toolbar, SyncTeX, and download behavior through PDF.js', async () => {
    const source = await readSource(latexPreviewUrl)

    expect(source).toContain('const pdfJsViewerRef = useRef<PdfJsViewerHandle | null>(null)')
    expect(source).toContain("activePdfViewer === 'pdfjs-viewer'")
    expect(source).toContain('pdfJsViewerRef.current?.scrollToPdfLocation')
    expect(source).toContain('jumpFromPdfJsDoubleClick')
    expect(source).toContain("setScaleValue('page-width')")
    expect(source).toContain('onScaleChanging={(scale) => setZoom(clampPdfZoom(scale))}')
    expect(source).toContain('syncMarker={pdfSyncMarker}')
    expect(source).toContain('download={pdfUrl ? downloadName : undefined}')
  })
})

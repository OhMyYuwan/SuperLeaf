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
    expect(viewerSource).toContain('callbacksRef.current.onLoadError')
    expect(viewerSource).toContain('}, [url, buildId])')
    expect(viewerSource).toContain('syncMarker')
    expect(viewerSource).toContain('zoom')
    expect(viewerSource).toContain("setScaleValue('page-width')")

    expect(wrapperSource).toContain('scrollToPdfLocation')
    expect(wrapperSource).toContain('pdfPointFromClientPosition')
    expect(wrapperSource).toContain('setScaleValue')
    expect(wrapperSource).toContain('this.activeUrl === url && this.viewer.pdfDocument')
    expect(wrapperSource).toContain('PdfJsViewportAnchor')
    expect(wrapperSource).toContain('captureViewportAnchor')
    expect(wrapperSource).toContain('restoreViewportAnchor')
    expect(wrapperSource).toContain('xRatio')
    expect(wrapperSource).toContain('yRatio')
    expect(wrapperSource).toContain('getPageElementAtViewportPoint')
    expect(wrapperSource).toContain('scrollToPage')
    expect(wrapperSource).toContain('showSyncMarker')
    expect(wrapperSource).toContain('clearSyncMarker')
  })

  it('routes LatexPreview toolbar, SyncTeX, and download behavior through PDF.js', async () => {
    const source = await readSource(latexPreviewUrl)

    expect(source).toContain("type PdfScaleMode = 'page-width' | 'custom'")
    expect(source).toContain("const [pdfScaleMode, setPdfScaleMode] = useState<PdfScaleMode>('page-width')")
    expect(source).toContain("setPdfScaleMode('custom')")
    expect(source).toContain("setPdfScaleMode('page-width')")
    expect(source).toContain('const pdfJsViewerRef = useRef<PdfJsViewerHandle | null>(null)')
    expect(source).toContain("activePdfViewer === 'pdfjs-viewer'")
    expect(source).toContain('pdfJsViewerRef.current?.scrollToPdfLocation')
    expect(source).toContain('jumpFromPdfJsDoubleClick')
    expect(source).toContain("setScaleValue('page-width')")
    expect(source).toContain("scaleMode={activePdfViewer === 'pdfjs-viewer' ? pdfScaleMode : 'custom'}")
    expect(source).toContain('onScaleChanging={(scale) => {')
    expect(source).toContain('syncMarker={pdfSyncMarker}')
    expect(source).toContain('download={pdfUrl ? downloadName : undefined}')
    expect(source).not.toContain('key={activeBuildId || pdfUrl}')
  })

  it('keeps PDF.js page-width as an explicit mode across recompiles', async () => {
    const viewerSource = await readSource(pdfJsViewerUrl)

    expect(viewerSource).toContain("type PdfJsScaleMode = 'page-width' | 'custom'")
    expect(viewerSource).toContain('scaleMode: PdfJsScaleMode')
    expect(viewerSource).toContain('scaleModeRef')
    expect(viewerSource).toContain("callbacksRef.current.scaleMode === 'page-width'")
    expect(viewerSource).not.toContain('callbacksRef.current.zoom === 1')
  })
})

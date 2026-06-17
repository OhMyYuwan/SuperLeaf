import { describe, expect, it } from 'vitest'

const fsPromisesSpecifier = 'node:fs/promises'
const pdfJsViewerUrl = new URL('./PdfJsViewer.tsx', import.meta.url)
const latexPreviewCssUrl = new URL('./latex-preview.css', import.meta.url)

describe('PDF preview chrome contract', () => {
  it('removes app-drawn page chrome from the react-pdf preview path', async () => {
    const { readFile } = (await import(fsPromisesSpecifier)) as {
      readFile: (path: URL, encoding: 'utf8') => Promise<string>
    }
    const css = await readFile(latexPreviewCssUrl, 'utf8')

    const reactPdfPageRule = css.match(
      /\.latex-pdf-page\s*\{(?<body>[^}]*)\}/s,
    )?.groups?.body
    expect(reactPdfPageRule).toContain('border: 0;')
    expect(reactPdfPageRule).toContain('outline: 0;')
    expect(reactPdfPageRule).toContain('box-shadow: none;')
    expect(reactPdfPageRule).toContain('background: #ffffff;')

    expect(css).toMatch(
      /\.latex-pdf-page\s+canvas\s*\{[^}]*border:\s*0;[^}]*outline:\s*0;[^}]*box-shadow:\s*none;[^}]*background:\s*#ffffff;/s,
    )
  })

  it('keeps PDF.js inside an app-owned outer shell and scroll container', async () => {
    const { readFile } = (await import(fsPromisesSpecifier)) as {
      readFile: (path: URL, encoding: 'utf8') => Promise<string>
    }
    const source = await readFile(pdfJsViewerUrl, 'utf8')

    expect(source).toContain('latex-pdfjs-outer')
    expect(source).toContain('latex-pdfjs-container')
    expect(source).toContain('pdfViewer removePageBorders')
  })

  it('prevents PDF.js dark chrome and page borders from leaking into preview', async () => {
    const { readFile } = (await import(fsPromisesSpecifier)) as {
      readFile: (path: URL, encoding: 'utf8') => Promise<string>
    }
    const css = await readFile(latexPreviewCssUrl, 'utf8')

    expect(css).toMatch(
      /\.latex-pdfjs-outer\s*\{[^}]*overflow:\s*hidden;[^}]*color-scheme:\s*light;/s,
    )
    expect(css).toMatch(
      /\.latex-pdfjs-container\s*\{[^}]*overflow:\s*auto;[^}]*color-scheme:\s*light;/s,
    )
    const pdfViewerRule = css.match(
      /\.latex-pdfjs-container\s+\.pdfViewer\s*\{(?<body>[^}]*)\}/s,
    )?.groups?.body
    expect(pdfViewerRule).toContain('min-height: 100%;')
    expect(pdfViewerRule).toContain('--page-bg-color: #ffffff;')
    expect(css).toMatch(
      /\.latex-pdfjs-container\s+\.pdfViewer\s+\.page\s*\{[^}]*border:\s*0\s*!important;[^}]*background-color:\s*#ffffff\s*!important;/s,
    )
    expect(css).toMatch(
      /\.latex-pdfjs-container\s+\.pdfViewer\s+\.page\s*\{[^}]*overflow:\s*hidden;/s,
    )
    expect(css).toMatch(
      /\.latex-pdfjs-container\s+\.pdfViewer\s+\.canvasWrapper,\s*\.latex-pdfjs-container\s+\.pdfViewer\s+\.page\s+canvas\s*\{[^}]*background:\s*#ffffff;/s,
    )
    expect(css).toMatch(
      /\.latex-pdfjs-container\s+\.pdfViewer\s+\.page,\s*\.latex-pdfjs-container\s+\.pdfViewer\s+\.canvasWrapper,\s*\.latex-pdfjs-container\s+\.pdfViewer\s+\.page\s+canvas\s*\{[^}]*border:\s*0\s*!important;[^}]*outline:\s*0\s*!important;[^}]*box-shadow:\s*none\s*!important;/s,
    )
  })
})

import { describe, expect, it } from 'vitest'

const fsPromisesSpecifier = 'node:fs/promises'
const previewColumnUrl = new URL('./PreviewColumn.tsx', import.meta.url)

async function readPreviewColumnSource() {
  const { readFile } = (await import(fsPromisesSpecifier)) as {
    readFile: (path: URL, encoding: 'utf8') => Promise<string>
  }
  return readFile(previewColumnUrl, 'utf8')
}

describe('PreviewColumn PDF file preview contract', () => {
  it('uses PDF.js for binary PDF file previews', async () => {
    const source = await readPreviewColumnSource()

    expect(source).toContain("import { PdfJsViewer } from '../preview/PdfJsViewer'")
    expect(source).toContain('<PdfJsViewer')
    expect(source).toContain('buildId={`file-${file.id}`}')
    expect(source).toContain('onLoadError')
    expect(source).not.toContain('<iframe')
    expect(source).not.toContain('pdfPreviewUrl')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LatexPreview } from '../features/preview/LatexPreview'

const mockStores = vi.hoisted(() => {
  const compileState = {
    compilers: { available: ['latexmk'], default: 'latexmk' },
    settings: { main_doc_id: 'doc-1', compiler: 'latexmk' },
    lastResult: {
      ok: true,
      compiler: 'latexmk',
      duration_ms: 120,
      error: '',
      log_tail: '',
      pdf_bytes: 2048,
    },
    compiling: false,
    pdfVersion: 3,
    autoCompile: false,
    fullLog: null,
    loadError: null,
    loadCompilers: vi.fn(),
    loadSettings: vi.fn(),
    updateSettings: vi.fn(),
    compile: vi.fn(),
    loadFullLog: vi.fn(),
    setAutoCompile: vi.fn(),
  }
  const documentState = {
    saveBackendDoc: vi.fn(),
    saveStatus: { 'doc-1': 'saved' },
    lastSavedAt: { 'doc-1': 1 },
  }
  const projectState = {
    currentProjectId: 'project-1',
    projects: [
      {
        id: 'project-1',
        name: 'Research Draft',
      },
    ],
  }

  return { compileState, documentState, projectState }
})

vi.mock('../stores/compileStore', () => {
  const useCompileStore = (selector: (state: typeof mockStores.compileState) => unknown) =>
    selector(mockStores.compileState)
  useCompileStore.getState = () => mockStores.compileState
  return { useCompileStore }
})

vi.mock('../stores/documentStore', () => {
  const useDocumentStore = (selector: (state: typeof mockStores.documentState) => unknown) =>
    selector(mockStores.documentState)
  useDocumentStore.getState = () => mockStores.documentState
  return { useDocumentStore }
})

vi.mock('../stores/projectStore', () => {
  const useProjectStore = (selector: (state: typeof mockStores.projectState) => unknown) =>
    selector(mockStores.projectState)
  return { useProjectStore }
})

vi.mock('react-pdf', () => ({
  Document: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Page: ({ pageNumber }: { pageNumber: number }) => <div data-page-number={pageNumber} />,
  pdfjs: {
    GlobalWorkerOptions: {
      workerSrc: '',
    },
  },
}))

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/pdf.worker.mock.js',
}))

describe('LatexPreview PDF download link', () => {
  it('opens the compiled PDF in a new tab while keeping the app tab in place', () => {
    const html = renderToStaticMarkup(
      <LatexPreview documentId="doc-1" source="\\documentclass{article}" />,
    )

    expect(html).toContain('class="small-btn latex-preview-download"')
    expect(html).toContain('href="http://127.0.0.1:8000/api/projects/project-1/compile.pdf?v=3"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain('download=')
  })
})

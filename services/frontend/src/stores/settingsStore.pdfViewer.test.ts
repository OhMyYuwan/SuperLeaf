import { afterEach, describe, expect, it, vi } from 'vitest'

async function importSettingsStoreWithLocalStorage(storedValue: string | null = null) {
  vi.resetModules()
  const storage = {
    getItem: vi.fn(() => storedValue),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }
  vi.stubGlobal('window', {
    localStorage: storage,
    location: {
      protocol: 'http:',
      hostname: 'localhost',
      port: '5173',
    },
  })
  vi.stubGlobal('localStorage', storage)

  const module = await import('./settingsStore')
  return { ...module, storage }
}

describe('settingsStore LaTeX PDF viewer preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('defaults to react-pdf so SyncTeX remains on the stable viewer', async () => {
    const { useSettingsStore } = await importSettingsStoreWithLocalStorage(null)

    expect(useSettingsStore.getState().latexPdfViewer).toBe('react-pdf')
  })

  it('persists an explicit PDF.js Viewer preference', async () => {
    const { useSettingsStore, storage } = await importSettingsStoreWithLocalStorage(null)

    useSettingsStore.getState().setLatexPdfViewer('pdfjs-viewer')

    expect(useSettingsStore.getState().latexPdfViewer).toBe('pdfjs-viewer')
    expect(storage.setItem).toHaveBeenCalledWith(
      'yuwanlab.latexPdfViewer',
      'pdfjs-viewer',
    )
  })
})

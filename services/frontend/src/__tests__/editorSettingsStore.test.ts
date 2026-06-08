import { afterEach, describe, expect, it, vi } from 'vitest'

const STORAGE: Record<string, string> = {}

function installLocalStorage(initial: Record<string, string> = {}) {
  for (const key of Object.keys(STORAGE)) delete STORAGE[key]
  Object.assign(STORAGE, initial)

  vi.stubGlobal('window', {
    location: {
      protocol: 'http:',
      hostname: '127.0.0.1',
    },
    localStorage: {
      getItem: (key: string) => STORAGE[key] ?? null,
      setItem: (key: string, value: string) => {
        STORAGE[key] = value
      },
      removeItem: (key: string) => {
        delete STORAGE[key]
      },
    },
  })
}

describe('settingsStore editor preferences', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('persists the selected LaTeX editor style', async () => {
    installLocalStorage()
    const { useSettingsStore } = await import('../stores/settingsStore')

    expect(useSettingsStore.getState().latexEditorTheme).toBe('light')

    useSettingsStore.getState().setLatexEditorTheme('overleaf-dark')

    expect(useSettingsStore.getState().latexEditorTheme).toBe('overleaf-dark')
    expect(STORAGE['yuwanlab.latexEditorTheme']).toBe('overleaf-dark')
  })

  it('falls back to the light editor style for unknown stored values', async () => {
    installLocalStorage({ 'yuwanlab.latexEditorTheme': 'solarized' })
    const { useSettingsStore } = await import('../stores/settingsStore')

    expect(useSettingsStore.getState().latexEditorTheme).toBe('light')
  })
})

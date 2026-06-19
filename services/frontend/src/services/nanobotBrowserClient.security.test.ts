import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readBrowserNanobotApiKey,
  storeBrowserNanobotApiKey,
} from './nanobotBrowserClient'

describe('nanobotBrowserClient secret storage policy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps browser Nanobot API keys in memory instead of browser storage', () => {
    const localStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    const sessionStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    vi.stubGlobal('localStorage', localStorageMock)
    vi.stubGlobal('sessionStorage', sessionStorageMock)

    storeBrowserNanobotApiKey('provider-1', 'sk-live-secret')

    expect(readBrowserNanobotApiKey('provider-1')).toBe('sk-live-secret')
    expect(localStorageMock.setItem).not.toHaveBeenCalled()
    expect(sessionStorageMock.setItem).not.toHaveBeenCalled()
  })

  it('does not restore browser Nanobot API keys from browser storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'sk-stale-local-storage-secret'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => 'sk-stale-session-storage-secret'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })

    expect(readBrowserNanobotApiKey('provider-from-storage')).toBe('dummy')
  })
})

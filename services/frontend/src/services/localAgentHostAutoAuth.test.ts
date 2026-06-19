import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeAgentApi } from './backendApi'
import {
  clearLocalAgentHostAuthToken,
  localAgentHostAuthHeaders,
} from './browserToolBridge'
import {
  bootstrapLocalAgentHostAuth,
  bootstrapLocalAgentHostAuthFromPackageInfo,
} from './localAgentHostAutoAuth'

vi.mock('./backendApi', () => ({
  nativeAgentApi: {
    localAgentHost: {
      info: vi.fn(),
    },
  },
}))

describe('localAgentHostAutoAuth', () => {
  afterEach(() => {
    clearLocalAgentHostAuthToken('http://127.0.0.1:8787')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('stores backend-brokered Local Agent Host tokens in memory only', () => {
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
    const token = 'sl_lah_abcdefghijklmnopqrstuvwxyz1234567890'

    expect(bootstrapLocalAgentHostAuthFromPackageInfo({
      version: '0.1.0',
      filename: 'superleaf-local-agent-host-0.1.0.zip',
      size_bytes: 1,
      checksum_algorithm: 'sha256',
      sha256: 'hash',
      download_path: '/api/native-agent/local-agent-host/download',
      endpoint: 'http://127.0.0.1:8787',
      mcp_url: 'http://127.0.0.1:8787/mcp',
      manifest_filename: 'superleaf-local-agent-host.manifest.json',
      manifest: {},
      included_files: [],
      macos: {},
      windows: {},
      codex_env: {},
      claude_env: {},
      local_auth_token: token,
      local_auth_token_source: 'file',
    })).toBe(true)

    expect(localAgentHostAuthHeaders('http://127.0.0.1:8787')).toEqual({
      'X-SuperLeaf-Local-Token': token,
    })
    expect(localStorageMock.setItem).not.toHaveBeenCalled()
    expect(sessionStorageMock.setItem).not.toHaveBeenCalled()
  })

  it('does not bootstrap from the backend package metadata endpoint by default', async () => {
    await expect(bootstrapLocalAgentHostAuth()).resolves.toBe(false)
    expect(nativeAgentApi.localAgentHost.info).not.toHaveBeenCalled()
  })

  it('bootstraps from the backend package metadata endpoint when explicitly enabled', async () => {
    vi.stubEnv('VITE_LOCAL_AGENT_HOST_AUTO_AUTH', '1')
    const token = 'sl_lah_backendtokenabcdefghijklmnopqrstuvwxyz123456'
    vi.mocked(nativeAgentApi.localAgentHost.info).mockResolvedValue({
      version: '0.1.0',
      filename: 'superleaf-local-agent-host-0.1.0.zip',
      size_bytes: 1,
      checksum_algorithm: 'sha256',
      sha256: 'hash',
      download_path: '/api/native-agent/local-agent-host/download',
      endpoint: 'http://127.0.0.1:8787',
      mcp_url: 'http://127.0.0.1:8787/mcp',
      manifest_filename: 'superleaf-local-agent-host.manifest.json',
      manifest: {},
      included_files: [],
      macos: {},
      windows: {},
      codex_env: {},
      claude_env: {},
      local_auth_token: token,
      local_auth_token_source: 'generated',
    })

    await expect(bootstrapLocalAgentHostAuth()).resolves.toBe(true)
    expect(localAgentHostAuthHeaders('http://127.0.0.1:8787')).toEqual({
      'X-SuperLeaf-Local-Token': token,
    })
  })
})

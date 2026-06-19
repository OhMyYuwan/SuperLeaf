import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearLocalAgentHostAuthToken,
  normalizeLocalAgentHostEndpoint,
  pollBrowserToolBridgeApprovalRequests,
  pollBrowserToolBridgeRequests,
  registerBrowserToolBridgeContext,
  startBrowserToolBridge,
  storeLocalAgentHostAuthToken,
  validateBrowserToolBridgeApprovalRequestBinding,
  validateBrowserToolBridgeRequestBinding,
} from './browserToolBridge'

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('browserToolBridge endpoint policy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('normalizes only localhost and loopback Local Agent endpoints', () => {
    expect(normalizeLocalAgentHostEndpoint('')).toBe('http://127.0.0.1:8787')
    expect(normalizeLocalAgentHostEndpoint(' http://localhost:8787/ ')).toBe('http://localhost:8787')
    expect(normalizeLocalAgentHostEndpoint('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787')
    expect(normalizeLocalAgentHostEndpoint('http://[::1]:8787/')).toBe('http://[::1]:8787')

    expect(() => normalizeLocalAgentHostEndpoint('https://agent.example.test')).toThrow(/loopback|localhost/i)
    expect(() => normalizeLocalAgentHostEndpoint('http://192.168.1.20:8787')).toThrow(/loopback|localhost/i)
  })

  it('does not post browser bridge context to untrusted endpoints', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => jsonResponse({
      status: 'ok',
      context_id: 'ctx_test',
      context_secret: 'secret',
      mcp_url: 'https://agent.example.test/mcp',
      tool_count: 1,
      expires_at: Date.now() + 60000,
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(registerBrowserToolBridgeContext({
      endpoint: 'https://agent.example.test',
      context: {
        projectId: 'project_1',
        conversationId: 'conversation_1',
        documentId: 'doc_1',
        rangeStart: 0,
        rangeEnd: 0,
        inputs: {},
        superleafOrigin: 'http://localhost:5173',
      },
    })).rejects.toThrow(/loopback|localhost/i)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('attaches browser-local Local Agent Host auth token to loopback context registration', async () => {
    const storage = new Map<string, string>()
    const localStorageMock = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, String(value))),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    }
    const sessionStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    vi.stubGlobal('localStorage', localStorageMock)
    vi.stubGlobal('sessionStorage', sessionStorageMock)
    const token = 'sl_lah_abcdefghijklmnopqrstuvwxyz1234567890'
    storeLocalAgentHostAuthToken('http://127.0.0.1:8787/', token)
    expect(localStorageMock.setItem).not.toHaveBeenCalled()
    expect(sessionStorageMock.setItem).not.toHaveBeenCalled()

    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => jsonResponse({
      status: 'ok',
      context_id: 'ctx_test',
      context_secret: 'secret',
      mcp_url: 'http://127.0.0.1:8787/mcp',
      tool_count: 1,
      expires_at: Date.now() + 60000,
    }))
    vi.stubGlobal('fetch', fetchMock)

    await registerBrowserToolBridgeContext({
      endpoint: 'http://127.0.0.1:8787',
      context: {
        projectId: 'project_1',
        conversationId: 'conversation_1',
        documentId: 'doc_1',
        rangeStart: 0,
        rangeEnd: 0,
        inputs: {},
        superleafOrigin: 'http://localhost:5173',
      },
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.headers).toMatchObject({
      'X-SuperLeaf-Local-Token': token,
    })
  })

  it('does not restore Local Agent Host auth token from browser storage', async () => {
    clearLocalAgentHostAuthToken('http://127.0.0.1:8787')
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'sl_lah_stale_browser_storage_token_value'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => 'sl_lah_stale_session_storage_token_value'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })

    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => jsonResponse({
      status: 'ok',
      context_id: 'ctx_test',
      context_secret: 'secret',
      mcp_url: 'http://127.0.0.1:8787/mcp',
      tool_count: 1,
      expires_at: Date.now() + 60000,
    }))
    vi.stubGlobal('fetch', fetchMock)

    await registerBrowserToolBridgeContext({
      endpoint: 'http://127.0.0.1:8787',
      context: {
        projectId: 'project_1',
        conversationId: 'conversation_1',
        documentId: 'doc_1',
        rangeStart: 0,
        rangeEnd: 0,
        inputs: {},
        superleafOrigin: 'http://localhost:5173',
      },
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.headers).not.toHaveProperty('X-SuperLeaf-Local-Token')
  })

  it('sends browser bridge context secret in headers instead of poll URLs', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => jsonResponse({
      status: 'ok',
      context_id: 'ctx_test',
      requests: [],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await pollBrowserToolBridgeRequests({
      endpoint: 'http://127.0.0.1:8787',
      contextId: 'ctx_test',
      contextSecret: 'ctx_secret_should_not_be_in_url',
      waitMs: 0,
    })
    await pollBrowserToolBridgeApprovalRequests({
      endpoint: 'http://127.0.0.1:8787',
      contextId: 'ctx_test',
      contextSecret: 'approval_ctx_secret_should_not_be_in_url',
      waitMs: 0,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [input, init] of fetchMock.mock.calls) {
      const url = new URL(String(input))
      expect(url.searchParams.get('context_id')).toBe('ctx_test')
      expect(url.searchParams.has('context_secret')).toBe(false)
      expect(init?.headers).toMatchObject({
        'X-SuperLeaf-Context-Token': expect.stringMatching(/ctx_secret_should_not_be_in_url|approval_ctx_secret_should_not_be_in_url/),
      })
    }
  })
})

describe('browserToolBridge request binding policy', () => {
  const activeContext = {
    contextId: 'ctx_current',
    projectId: 'project_current',
    conversationId: 'conversation_current',
    documentId: 'document_current',
  }

  const matchingRequest = {
    id: 'request_1',
    lease_secret: 'lease_1',
    name: 'project_read_doc',
    arguments: {},
    agent_name: 'Codex',
    context_id: activeContext.contextId,
    project_id: activeContext.projectId,
    conversation_id: activeContext.conversationId,
    document_id: activeContext.documentId,
    range_start: 0,
    range_end: 0,
    inputs: {},
    created_at: new Date(0).toISOString(),
  }

  it('allows tool requests bound to the active browser bridge context', () => {
    expect(validateBrowserToolBridgeRequestBinding(matchingRequest, activeContext)).toEqual({
      ok: true,
      message: '',
      mismatches: [],
    })
  })

  it('rejects tool requests that try to spend the browser session on another resource', () => {
    const cases = [
      ['context_id', { context_id: 'ctx_other' }],
      ['project_id', { project_id: 'project_other' }],
      ['conversation_id', { conversation_id: 'conversation_other' }],
      ['document_id', { document_id: 'document_other' }],
    ] as const

    for (const [field, patch] of cases) {
      const result = validateBrowserToolBridgeRequestBinding({
        ...matchingRequest,
        ...patch,
      }, activeContext)
      expect(result.ok).toBe(false)
      expect(result.mismatches).toContain(field)
      expect(result.message).toMatch(/does not match active SuperLeaf context/i)
    }
  })

  it('rejects approval requests that target another active resource binding', () => {
    const approvalRequest = {
      id: 'approval_1',
      approval_secret: 'approval_secret_1',
      method: 'sampling/confirm',
      title: 'Approve local action',
      summary: '',
      detail: '',
      tool_name: 'project_write_text_file',
      context_id: activeContext.contextId,
      context_secret: 'server_should_not_win',
      project_id: 'project_other',
      conversation_id: activeContext.conversationId,
      document_id: activeContext.documentId,
      created_at: new Date(0).toISOString(),
      expires_at: Date.now() + 60000,
    }

    const result = validateBrowserToolBridgeApprovalRequestBinding(approvalRequest, activeContext)

    expect(result.ok).toBe(false)
    expect(result.mismatches).toEqual(['project_id'])
    expect(result.message).toMatch(/does not match active SuperLeaf context/i)
  })

  it('rejects mismatched approval requests before surfacing them to the UI', async () => {
    let approvalPollCalls = 0
    const submittedApprovalBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      if (url.endsWith('/superleaf/mcp/context')) {
        return jsonResponse({
          status: 'ok',
          context_id: 'ctx_test',
          context_secret: 'ctx_secret_test',
          mcp_url: 'http://127.0.0.1:8787/mcp',
          tool_count: 1,
          expires_at: Date.now() + 60000,
        })
      }
      if (url.includes('/superleaf/mcp/tool-requests')) {
        return await new Promise<Response>((resolve) => {
          const signal = init?.signal
          const finish = () => resolve(jsonResponse({ status: 'ok', context_id: 'ctx_test', requests: [] }))
          if (signal?.aborted) finish()
          else signal?.addEventListener('abort', finish, { once: true })
        })
      }
      if (url.includes('/superleaf/mcp/approval-requests')) {
        approvalPollCalls += 1
        if (approvalPollCalls === 1) {
          return jsonResponse({
            status: 'ok',
            context_id: 'ctx_test',
            requests: [{
              id: 'approval_1',
              approval_secret: 'approval_secret_1',
              method: 'sampling/confirm',
              title: 'Approve write',
              summary: '',
              detail: '',
              tool_name: 'project_write_text_file',
              context_id: 'ctx_test',
              project_id: 'project_other',
              conversation_id: 'conversation_1',
              document_id: 'doc_1',
              created_at: new Date().toISOString(),
              expires_at: Date.now() + 60000,
            }],
          })
        }
        return await new Promise<Response>((resolve) => {
          const signal = init?.signal
          const finish = () => resolve(jsonResponse({ status: 'ok', context_id: 'ctx_test', requests: [] }))
          if (signal?.aborted) finish()
          else signal?.addEventListener('abort', finish, { once: true })
        })
      }
      if (url.endsWith('/superleaf/mcp/approval-results')) {
        submittedApprovalBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return jsonResponse({ status: 'ok', request_id: 'approval_1' })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost:5173' },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    })

    const parent = new AbortController()
    const onApprovalRequest = vi.fn()
    const approvalErrors: unknown[] = []
    const bridge = await startBrowserToolBridge({
      endpoint: 'http://127.0.0.1:8787',
      context: {
        projectId: 'project_1',
        conversationId: 'conversation_1',
        documentId: 'doc_1',
        rangeStart: 0,
        rangeEnd: 0,
        inputs: {},
      },
      parentSignal: parent.signal,
      executeRequest: vi.fn(),
      waitMs: 0,
      refreshMs: 0,
      onApprovalRequest,
      onApprovalPollError: (err) => approvalErrors.push(err),
    })

    try {
      await vi.waitFor(() => expect(approvalPollCalls).toBeGreaterThan(0))
      await vi.waitFor(() => expect(submittedApprovalBodies).toHaveLength(1))

      expect(onApprovalRequest).not.toHaveBeenCalled()
      expect(submittedApprovalBodies[0]).toMatchObject({
        request_id: 'approval_1',
        context_secret: 'ctx_secret_test',
        approval_secret: 'approval_secret_1',
        decision: 'reject',
      })
      expect(String(approvalErrors[0])).toMatch(/project_id/i)
    } finally {
      bridge.stop()
      parent.abort()
    }
  })
})

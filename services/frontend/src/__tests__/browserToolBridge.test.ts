import { afterEach, describe, expect, it, vi } from 'vitest'
import { startBrowserToolBridge } from '../services/browserToolBridge'

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('browserToolBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('submits a failed tool result when browser-side execution exceeds the request timeout', async () => {
    vi.useFakeTimers()
    const submittedBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/superleaf/mcp/context')) {
        return jsonResponse({
          status: 'ok',
          context_id: 'ctx_test',
          mcp_url: 'http://127.0.0.1:8787/mcp',
          tool_count: 1,
          expires_at: Date.now() + 60000,
        })
      }
      if (url.includes('/superleaf/mcp/tool-requests')) {
        return jsonResponse({
          status: 'ok',
          context_id: 'ctx_test',
          requests: [{
            id: 'req_1',
            name: 'project_read_doc',
            arguments: {},
            context_id: 'ctx_test',
            project_id: 'project_1',
            conversation_id: 'conversation_1',
            document_id: 'doc_1',
            range_start: 0,
            range_end: 0,
            inputs: {},
            created_at: new Date().toISOString(),
          }],
        })
      }
      if (url.endsWith('/superleaf/mcp/tool-results')) {
        submittedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return jsonResponse({ status: 'ok', request_id: 'req_1' })
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
    const executeRequest = vi.fn((_request, signal: AbortSignal): Promise<never> =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    )

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
      executeRequest,
      waitMs: 0,
      refreshMs: 0,
      requestTimeoutMs: 1000,
    })

    await vi.waitFor(() => expect(executeRequest).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(submittedBodies.length).toBeGreaterThan(0))

    expect(submittedBodies[0].request_id).toBe('req_1')
    expect(submittedBodies[0].failed).toBe(true)
    expect(String(submittedBodies[0].content)).toContain('timed out')

    bridge.stop()
    parent.abort()
  })
})

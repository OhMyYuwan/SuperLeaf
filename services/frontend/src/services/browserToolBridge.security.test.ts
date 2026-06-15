import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeLocalAgentHostEndpoint,
  registerBrowserToolBridgeContext,
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
    const fetchMock = vi.fn(async () => jsonResponse({
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
})

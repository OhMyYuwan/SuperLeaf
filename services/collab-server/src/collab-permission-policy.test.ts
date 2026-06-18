import assert from 'node:assert/strict'
import http from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  COLLAB_HTTP_ROUTE_TEST_POLICIES,
  COLLAB_HTTP_ROUTE_POLICIES,
  findMissingCollabHttpRouteTestFiles,
  findStaleCollabHttpRouteTestPolicies,
  findUncoveredCollabHttpRouteTestPolicies,
  handleHttpRequest,
  matchCollabHttpRoutePolicy,
  validateCollabHttpPermissionRegistry,
  type CollabHttpRoutePolicy,
  type CollabHttpRouteTestPolicy,
  type HttpIntegration,
} from './persistence.js'
import {
  COLLAB_WS_UPGRADE_POLICIES,
} from './upgrade-auth.js'
import {
  buildCollabServerPermissionEvidenceMatrix,
} from './permission-policy.js'

class MockResponse {
  statusCode: number | null = null
  body = ''
  headers: http.OutgoingHttpHeaders | undefined

  writeHead(statusCode: number, headers?: http.OutgoingHttpHeaders): this {
    this.statusCode = statusCode
    this.headers = headers
    return this
  }

  end(chunk?: string | Buffer): this {
    if (chunk) {
      this.body += chunk.toString()
    }
    return this
  }
}

test('collab HTTP permission registry is sparse and self-consistent', () => {
  assert.deepEqual(validateCollabHttpPermissionRegistry(), [])
  assert.ok(COLLAB_HTTP_ROUTE_POLICIES.some((policy) => policy.authSurface === 'public'))
  assert.ok(COLLAB_HTTP_ROUTE_POLICIES.some((policy) => policy.authSurface === 'internal-token'))

  assert.equal(
    matchCollabHttpRoutePolicy('GET', '/health')?.routeId,
    'health',
  )
  assert.equal(
    matchCollabHttpRoutePolicy('GET', '/docs/doc-1/text')?.routeId,
    'doc_text_read',
  )
  assert.equal(
    matchCollabHttpRoutePolicy('PUT', '/docs/doc-1/text')?.routeId,
    'doc_text_replace',
  )
  assert.equal(
    matchCollabHttpRoutePolicy('POST', '/docs/doc-1/invalidate')?.routeId,
    'doc_invalidate',
  )
})

test('collab HTTP permission registry reports duplicates and unknown auth surfaces', () => {
  const policies: CollabHttpRoutePolicy[] = [
    {
      routeId: 'a',
      method: 'GET',
      path: '/docs/active',
      authSurface: 'internal-token',
      resource: 'collab_doc',
      action: 'list_active',
    },
    {
      routeId: 'b',
      method: 'GET',
      path: '/docs/active',
      authSurface: 'browser-session' as never,
      resource: 'collab_doc',
      action: 'list_active',
    },
  ]

  const errors = validateCollabHttpPermissionRegistry(policies)

  assert.ok(errors.includes('duplicate collab HTTP policy GET /docs/active'))
  assert.ok(errors.includes('collab HTTP GET /docs/active has unknown auth surface browser-session'))
})

test('collab HTTP behavior coverage registry reports missing and stale entries', () => {
  const policies: CollabHttpRoutePolicy[] = [
    {
      routeId: 'health',
      method: 'GET',
      path: '/health',
      authSurface: 'public',
      resource: 'collab_health',
      action: 'read',
    },
    {
      routeId: 'doc_text_read',
      method: 'GET',
      path: '/docs/{docId}/text',
      authSurface: 'internal-token',
      resource: 'collab_doc',
      action: 'read_text',
    },
  ]
  const coverage: CollabHttpRouteTestPolicy[] = [
    {
      routeId: 'health',
      testModule: 'src/collab-permission-policy.test.ts',
      evidence: 'health route is public',
    },
    {
      routeId: 'ghost',
      testModule: 'src/collab-permission-policy.test.ts',
      evidence: 'stale coverage',
    },
  ]

  assert.deepEqual(
    findUncoveredCollabHttpRouteTestPolicies(policies, coverage),
    ['collab HTTP route doc_text_read has no behavior test coverage'],
  )
  assert.deepEqual(
    findStaleCollabHttpRouteTestPolicies(policies, coverage),
    ['collab HTTP coverage ghost references no route policy'],
  )
})

test('collab HTTP behavior coverage registry reports missing test files', () => {
  const coverage: CollabHttpRouteTestPolicy[] = [
    {
      routeId: 'health',
      testModule: 'src/present.test.ts',
      evidence: 'present',
    },
    {
      routeId: 'doc_text_read',
      testModule: 'src/missing.test.ts',
      evidence: 'missing',
    },
  ]

  assert.deepEqual(
    findMissingCollabHttpRouteTestFiles('/repo', coverage, (filePath) => {
      return filePath.endsWith('src/present.test.ts')
    }),
    ['collab HTTP coverage doc_text_read references missing test file src/missing.test.ts'],
  )
})

test('collab HTTP route policies have behavior test coverage', () => {
  assert.deepEqual(
    findUncoveredCollabHttpRouteTestPolicies(COLLAB_HTTP_ROUTE_POLICIES),
    [],
  )
  assert.deepEqual(
    findStaleCollabHttpRouteTestPolicies(COLLAB_HTTP_ROUTE_POLICIES),
    [],
  )
  assert.deepEqual(
    findMissingCollabHttpRouteTestFiles(process.cwd(), COLLAB_HTTP_ROUTE_TEST_POLICIES),
    [],
  )
})

test('collab-server materialized permission evidence matrix covers HTTP and WebSocket entrypoints', () => {
  const matrix = buildCollabServerPermissionEvidenceMatrix()
  const expectedKeys = [
    ...COLLAB_HTTP_ROUTE_POLICIES.map((policy) => `http:${policy.routeId}`),
    ...COLLAB_WS_UPGRADE_POLICIES.map((policy) => `websocket:${policy.routeId}`),
  ].sort()

  assert.deepEqual(
    matrix.map((row) => `${row.entrypoint}:${row.routeId}`).sort(),
    expectedKeys,
  )

  for (const row of matrix) {
    assert.ok(row.routeId)
    assert.ok(row.path.startsWith('/'))
    assert.ok(row.authSurface)
    assert.ok(row.resource)
    assert.ok(row.action)
    assert.ok(row.subjectBinding)
    assert.ok(row.ownerBoundary)
    assert.ok(row.runtimeGuards.length > 0, row.routeId)
    assert.ok(row.behaviorEvidence.length > 0, row.routeId)
  }

  const textRead = matrix.find((row) => row.entrypoint === 'http' && row.routeId === 'doc_text_read')
  assert.equal(textRead?.subjectBinding, 'backend-internal-token')
  assert.equal(textRead?.ownerBoundary, 'backend-authorized-doc')
  assert.ok(textRead?.runtimeGuards.includes('collab-internal-token'))
  assert.ok(textRead?.runtimeGuards.includes('historical-default-token-disabled'))

  const wsSync = matrix.find((row) => row.entrypoint === 'websocket' && row.routeId === 'document_yjs_sync')
  assert.equal(wsSync?.subjectBinding, 'backend-verified-user-doc')
  assert.equal(wsSync?.ownerBoundary, 'backend-doc-membership')
  assert.ok(wsSync?.runtimeGuards.includes('backend-doc-id-verifier'))
  assert.ok(wsSync?.runtimeGuards.includes('collab-generation-check'))
  assert.ok(wsSync?.runtimeGuards.includes('message-time-reauth'))
  assert.equal(wsSync?.behaviorEvidence.length, 2)
})

test('collab HTTP document data routes reject unauthenticated internal requests before data access', () => {
  const calls: string[] = []
  const integration: HttpIntegration = {
    getActiveDocIds: () => {
      calls.push('getActiveDocIds')
      return ['doc-1']
    },
    getLoadedDocText: (docId) => {
      calls.push(`getLoadedDocText:${docId}`)
      return 'secret text'
    },
    replaceDocText: async (docId, text) => {
      calls.push(`replaceDocText:${docId}:${text}`)
      return { active: true, length: text.length, connectionsClosed: 0 }
    },
    invalidateDoc: async (docId) => {
      calls.push(`invalidateDoc:${docId}`)
      return { active: true, connectionsClosed: 0, cleared: true }
    },
  }

  const protectedPolicies = COLLAB_HTTP_ROUTE_POLICIES.filter(
    (policy) => policy.authSurface === 'internal-token',
  )
  assert.ok(protectedPolicies.length > 0)

  for (const policy of protectedPolicies) {
    const res = new MockResponse()
    handleHttpRequest(
      makeRequest(policy.method, samplePath(policy)),
      res as unknown as http.ServerResponse,
      integration,
    )

    assert.equal(res.statusCode, 401, `${policy.method} ${policy.path}`)
    assert.equal(res.body, 'Unauthorized', `${policy.method} ${policy.path}`)
  }

  assert.deepEqual(calls, [])
})

test('collab HTTP health route is explicitly public', () => {
  const res = new MockResponse()

  handleHttpRequest(
    makeRequest('GET', '/health'),
    res as unknown as http.ServerResponse,
    unusedIntegration(),
  )

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body) as unknown, { status: 'ok' })
})

function makeRequest(
  method: string,
  url: string,
  headers: http.IncomingHttpHeaders = {},
): http.IncomingMessage {
  const req = new Readable({
    read() {
      this.push(null)
    },
  }) as http.IncomingMessage
  req.method = method
  req.url = url
  req.headers = { host: 'collab.test', ...headers }
  return req
}

function samplePath(policy: CollabHttpRoutePolicy): string {
  return policy.path.replace('{docId}', encodeURIComponent('doc-1'))
}

function unusedIntegration(): HttpIntegration {
  return {
    getActiveDocIds: () => {
      throw new Error('should not list active docs')
    },
    getLoadedDocText: () => {
      throw new Error('should not read doc text')
    },
    replaceDocText: async () => {
      throw new Error('should not replace doc text')
    },
    invalidateDoc: async () => {
      throw new Error('should not invalidate doc')
    },
  }
}

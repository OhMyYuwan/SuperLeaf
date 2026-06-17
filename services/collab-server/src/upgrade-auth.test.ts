import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COLLAB_GENERATION_PROTOCOL_PREFIX,
  COLLAB_TOKEN_PROTOCOL_PREFIX,
  COLLAB_WS_UPGRADE_TEST_POLICIES,
  COLLAB_WS_UPGRADE_POLICIES,
  createUpgradeAuthLimiter,
  findMissingCollabWsUpgradeTestFiles,
  findStaleCollabWsUpgradeTestPolicies,
  findUncoveredCollabWsUpgradeTestPolicies,
  parseCollabProtocols,
  resolveCollabWsUpgrade,
  validateCollabWsUpgradeRegistry,
  verifyToken,
  type CollabAuditRecorder,
  type CollabWsUpgradePolicy,
  type CollabWsUpgradeTestPolicy,
} from './upgrade-auth.js'

test('collab WebSocket upgrade permission registry is sparse and self-consistent', () => {
  assert.deepEqual(validateCollabWsUpgradeRegistry(), [])
  assert.deepEqual(COLLAB_WS_UPGRADE_POLICIES, [
    {
      routeId: 'document_yjs_sync',
      path: '/{docId}',
      authSurface: 'collab-token-subprotocol',
      resource: 'doc',
      action: 'collab_sync',
      backendVerifierPath: '/api/auth/verify',
      backendVerifierDocIdParam: 'doc_id',
      requiresGenerationCheck: true,
      requiresMessageReauth: true,
    },
  ])
})

test('collab WebSocket upgrade registry reports duplicate routes and unknown auth surfaces', () => {
  const policies: CollabWsUpgradePolicy[] = [
    {
      routeId: 'a',
      path: '/{docId}',
      authSurface: 'collab-token-subprotocol',
      resource: 'doc',
      action: 'collab_sync',
      backendVerifierPath: '/api/auth/verify',
      backendVerifierDocIdParam: 'doc_id',
      requiresGenerationCheck: true,
      requiresMessageReauth: true,
    },
    {
      routeId: 'b',
      path: '/{docId}',
      authSurface: 'query-token' as never,
      resource: 'doc',
      action: 'collab_sync',
      backendVerifierPath: '/verify',
      backendVerifierDocIdParam: 'document',
      requiresGenerationCheck: false,
      requiresMessageReauth: false,
    },
  ]

  const errors = validateCollabWsUpgradeRegistry(policies)

  assert.ok(errors.includes('duplicate collab WebSocket upgrade policy /{docId}'))
  assert.ok(errors.includes('collab WebSocket /{docId} has unknown auth surface query-token'))
  assert.ok(errors.includes('collab WebSocket /{docId} must verify with /api/auth/verify'))
  assert.ok(errors.includes('collab WebSocket /{docId} must pass doc_id to backend verifier'))
  assert.ok(errors.includes('collab WebSocket /{docId} must require generation check'))
  assert.ok(errors.includes('collab WebSocket /{docId} must require message-time reauthorization'))
})

test('collab WebSocket behavior coverage registry reports missing and stale entries', () => {
  const policies: CollabWsUpgradePolicy[] = [
    {
      routeId: 'document_yjs_sync',
      path: '/{docId}',
      authSurface: 'collab-token-subprotocol',
      resource: 'doc',
      action: 'collab_sync',
      backendVerifierPath: '/api/auth/verify',
      backendVerifierDocIdParam: 'doc_id',
      requiresGenerationCheck: true,
      requiresMessageReauth: true,
    },
    {
      routeId: 'document_yjs_snapshot',
      path: '/snapshot/{docId}',
      authSurface: 'collab-token-subprotocol',
      resource: 'doc',
      action: 'collab_sync',
      backendVerifierPath: '/api/auth/verify',
      backendVerifierDocIdParam: 'doc_id',
      requiresGenerationCheck: true,
      requiresMessageReauth: true,
    },
  ]
  const coverage: CollabWsUpgradeTestPolicy[] = [
    {
      routeId: 'document_yjs_sync',
      testModule: 'src/upgrade-auth.test.ts',
      evidence: 'sync route verifies doc_id',
    },
    {
      routeId: 'ghost',
      testModule: 'src/upgrade-auth.test.ts',
      evidence: 'stale coverage',
    },
  ]

  assert.deepEqual(
    findUncoveredCollabWsUpgradeTestPolicies(policies, coverage),
    ['collab WebSocket route document_yjs_snapshot has no behavior test coverage'],
  )
  assert.deepEqual(
    findStaleCollabWsUpgradeTestPolicies(policies, coverage),
    ['collab WebSocket coverage ghost references no route policy'],
  )
})

test('collab WebSocket behavior coverage registry reports missing test files', () => {
  const coverage: CollabWsUpgradeTestPolicy[] = [
    {
      routeId: 'document_yjs_sync',
      testModule: 'src/present.test.ts',
      evidence: 'present',
    },
    {
      routeId: 'document_yjs_snapshot',
      testModule: 'src/missing.test.ts',
      evidence: 'missing',
    },
  ]

  assert.deepEqual(
    findMissingCollabWsUpgradeTestFiles('/repo', coverage, (filePath) => {
      return filePath.endsWith('src/present.test.ts')
    }),
    ['collab WebSocket coverage document_yjs_snapshot references missing test file src/missing.test.ts'],
  )
})

test('collab WebSocket upgrade policies have behavior test coverage', () => {
  assert.deepEqual(
    findUncoveredCollabWsUpgradeTestPolicies(COLLAB_WS_UPGRADE_POLICIES),
    [],
  )
  assert.deepEqual(
    findStaleCollabWsUpgradeTestPolicies(COLLAB_WS_UPGRADE_POLICIES),
    [],
  )
  assert.deepEqual(
    findMissingCollabWsUpgradeTestFiles(process.cwd(), COLLAB_WS_UPGRADE_TEST_POLICIES),
    [],
  )
})

test('resolveCollabWsUpgrade extracts doc id and collab subprotocols without query tokens', () => {
  const rawProtocols = [
    `${COLLAB_TOKEN_PROTOCOL_PREFIX}token-1`,
    `${COLLAB_GENERATION_PROTOCOL_PREFIX}42`,
    'ignored-protocol',
  ].join(', ')

  const resolved = resolveCollabWsUpgrade('/collab/doc%201?token=ignored', rawProtocols, '/collab')

  assert.equal(resolved.policy?.routeId, 'document_yjs_sync')
  assert.equal(resolved.docId, 'doc 1')
  assert.equal(resolved.token, 'token-1')
  assert.equal(resolved.clientGeneration, 42)
})

test('resolveCollabWsUpgrade rejects paths outside the configured WebSocket prefix', () => {
  const resolved = resolveCollabWsUpgrade('/other/doc-1', `${COLLAB_TOKEN_PROTOCOL_PREFIX}token-1`, '/collab')

  assert.equal(resolved.policy, null)
  assert.equal(resolved.docId, null)
  assert.equal(resolved.token, 'token-1')
})

test('parseCollabProtocols ignores invalid generation values', () => {
  assert.deepEqual(
    parseCollabProtocols([
      `${COLLAB_TOKEN_PROTOCOL_PREFIX}token-1`,
      `${COLLAB_GENERATION_PROTOCOL_PREFIX}not-a-number`,
    ]),
    {
      token: 'token-1',
      clientGeneration: null,
    },
  )
})

test('verifyToken aborts stalled backend verification after the timeout', async () => {
  let aborted = false
  const events: Array<{ event: string; code?: string }> = []
  const recordEvent: CollabAuditRecorder = async (event, fields) => {
    events.push({ event, code: fields.code })
  }
  const fetchImpl: typeof fetch = async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => {
        aborted = true
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
  }

  const session = await verifyToken('token-1', 'http://backend.test', 'doc-1', {
    timeoutMs: 1,
    fetchImpl,
    recordEvent,
  })

  assert.equal(session, null)
  assert.equal(aborted, true)
  assert.deepEqual(events, [{ event: 'token_verify_timeout', code: 'token_verify_timeout' }])
})

test('verifyToken rejects oversized tokens before calling the backend', async () => {
  let fetchCalled = false
  const events: Array<{ event: string; code?: string }> = []
  const recordEvent: CollabAuditRecorder = async (event, fields) => {
    events.push({ event, code: fields.code })
  }
  const fetchImpl: typeof fetch = async () => {
    fetchCalled = true
    throw new Error('fetch should not be called')
  }

  const session = await verifyToken('x'.repeat(6), 'http://backend.test', 'doc-1', {
    maxTokenChars: 5,
    fetchImpl,
    recordEvent,
  })

  assert.equal(session, null)
  assert.equal(fetchCalled, false)
  assert.deepEqual(events, [{ event: 'token_verify_rejected', code: 'token_too_large' }])
})

test('verifyToken sends doc_id to the backend authorization verifier', async () => {
  let verifiedUrl: URL | null = null
  const fetchImpl: typeof fetch = async (input) => {
    verifiedUrl = new URL(String(input))
    return new Response(JSON.stringify({
      user_id: 'user-1',
      display_name: 'User One',
      collab_generation: 7,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const session = await verifyToken('token-1', 'http://backend.test/root', 'doc 1', {
    fetchImpl,
  })

  assert.deepEqual(session, {
    user: { id: 'user-1', name: 'User One' },
    collabGeneration: 7,
  })
  assert.equal(verifiedUrl?.pathname, '/api/auth/verify')
  assert.equal(verifiedUrl?.searchParams.get('doc_id'), 'doc 1')
})

test('createUpgradeAuthLimiter enforces pending upgrade budget', () => {
  const limiter = createUpgradeAuthLimiter(1)
  const release = limiter.tryAcquire()

  assert.equal(typeof release, 'function')
  assert.equal(limiter.pendingCount, 1)
  assert.equal(limiter.tryAcquire(), null)

  release?.()
  assert.equal(limiter.pendingCount, 0)
  assert.equal(typeof limiter.tryAcquire(), 'function')
})

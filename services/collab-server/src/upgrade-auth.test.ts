import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createUpgradeAuthLimiter,
  verifyToken,
  type CollabAuditRecorder,
} from './upgrade-auth.js'

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

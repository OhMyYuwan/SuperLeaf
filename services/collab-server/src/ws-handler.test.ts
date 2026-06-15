import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

const MSG_SYNC = 0

class FakeSocket {
  readyState = 1
  sent: Uint8Array[] = []
  closed: { code?: number; reason?: string } | null = null
  private listeners = new Map<string, Array<(data?: unknown) => void>>()

  on(event: string, fn: (data?: unknown) => void): void {
    const existing = this.listeners.get(event) ?? []
    existing.push(fn)
    this.listeners.set(event, existing)
  }

  send(data: Uint8Array): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
    this.readyState = 3
    this.emit('close')
  }

  emit(event: string, data?: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) {
      fn(data)
    }
  }
}

test('setupWSConnection replies to client sync step1 sent before room load finishes', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ylw-collab-test-'))
  process.env.COLLAB_DATA_DIR = dataDir
  const originalFetch = globalThis.fetch
  const persistence = await import('./persistence.js')
  let ws: FakeSocket | null = null
  try {
    globalThis.fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return new Response(JSON.stringify({ content: 'server text' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    persistence.initPersistence()
    const { setupWSConnection } = await import('./ws-handler.js')
    ws = new FakeSocket()

    setupWSConnection(
      ws as never,
      'doc-early-sync',
      { id: 'user-1', name: 'User One' },
      'token-1',
    )
    ws.emit('message', Buffer.from(clientSyncStep1()))

    await waitFor(() => ws.sent.some(isSyncStep2))
  } finally {
    ws?.emit('close')
    globalThis.fetch = originalFetch
    await persistence.getPersistence().destroy()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('replaceDocText updates active room text and notifies clients', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ylw-collab-test-'))
  process.env.COLLAB_DATA_DIR = dataDir
  const originalFetch = globalThis.fetch
  const persistence = await import('./persistence.js')
  let ws: FakeSocket | null = null
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ content: 'server text' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

    persistence.initPersistence()
    const { setupWSConnection, getLoadedDocText, replaceDocText } = await import('./ws-handler.js')
    ws = new FakeSocket()

    setupWSConnection(
      ws as never,
      'doc-replace-active',
      { id: 'user-1', name: 'User One' },
      'token-1',
    )

    await waitFor(() => getLoadedDocText('doc-replace-active') === 'server text')
    const sentBeforeReplace = ws.sent.length

    const result = await replaceDocText('doc-replace-active', 'restored text')

    assert.deepEqual(result, { active: true, length: 13, connectionsClosed: 1 })
    assert.equal(getLoadedDocText('doc-replace-active'), 'restored text')
    assert.ok(ws.sent.length > sentBeforeReplace)
    assert.deepEqual(ws.closed, { code: 4009, reason: 'collab_doc_replaced' })
  } finally {
    ws?.emit('close')
    globalThis.fetch = originalFetch
    await persistence.getPersistence().destroy()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('setupWSConnection rejects stale collaboration generation before loading room', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ylw-collab-test-'))
  process.env.COLLAB_DATA_DIR = dataDir
  const persistence = await import('./persistence.js')
  try {
    persistence.initPersistence()
    const { setupWSConnection, getActiveDocIds } = await import('./ws-handler.js')
    const ws = new FakeSocket()

    setupWSConnection(
      ws as never,
      'doc-stale-generation',
      { id: 'user-1', name: 'User One' },
      'token-1',
      { clientGeneration: 1, authoritativeGeneration: 2 },
    )

    assert.deepEqual(ws.closed, { code: 4009, reason: 'collab_doc_replaced' })
    assert.deepEqual(getActiveDocIds(), [])
  } finally {
    await persistence.getPersistence().destroy()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('setupWSConnection closes revoked sockets before applying client updates', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ylw-collab-test-'))
  process.env.COLLAB_DATA_DIR = dataDir
  const originalFetch = globalThis.fetch
  const persistence = await import('./persistence.js')
  let ws: FakeSocket | null = null
  let authorized = true
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ content: 'server text' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

    persistence.initPersistence()
    const { setupWSConnection, getLoadedDocText } = await import('./ws-handler.js')
    ws = new FakeSocket()

    setupWSConnection(
      ws as never,
      'doc-revoked-message',
      { id: 'user-1', name: 'User One' },
      'token-1',
      { authorizeMessage: async () => authorized },
    )

    await waitFor(() => getLoadedDocText('doc-revoked-message') === 'server text')
    authorized = false
    ws.emit('message', Buffer.from(clientTextUpdate('revoked text')))

    await waitFor(() => ws?.closed?.reason === 'collab_auth_revoked')
    assert.equal(getLoadedDocText('doc-revoked-message'), 'server text')
  } finally {
    ws?.emit('close')
    globalThis.fetch = originalFetch
    await persistence.getPersistence().destroy()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('setupWSConnection applies client updates while authorization remains valid', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ylw-collab-test-'))
  process.env.COLLAB_DATA_DIR = dataDir
  const originalFetch = globalThis.fetch
  const persistence = await import('./persistence.js')
  let ws: FakeSocket | null = null
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ content: 'server text' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

    persistence.initPersistence()
    const { setupWSConnection, getLoadedDocText } = await import('./ws-handler.js')
    ws = new FakeSocket()

    setupWSConnection(
      ws as never,
      'doc-authorized-message',
      { id: 'user-1', name: 'User One' },
      'token-1',
      { authorizeMessage: async () => true },
    )

    await waitFor(() => getLoadedDocText('doc-authorized-message') === 'server text')
    ws.emit('message', Buffer.from(clientTextUpdate('client text')))

    await waitFor(() => getLoadedDocText('doc-authorized-message')?.includes('client text') ?? false)
    assert.equal(ws.closed, null)
  } finally {
    ws?.emit('close')
    globalThis.fetch = originalFetch
    await persistence.getPersistence().destroy()
    await rm(dataDir, { recursive: true, force: true })
  }
})

function clientSyncStep1(): Uint8Array {
  const doc = new Y.Doc()
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}

function clientTextUpdate(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc))
  return encoding.toUint8Array(encoder)
}

function isSyncStep2(message: Uint8Array): boolean {
  const decoder = decoding.createDecoder(message)
  const messageType = decoding.readVarUint(decoder)
  if (messageType !== MSG_SYNC) return false
  const syncType = decoding.readVarUint(decoder)
  return syncType === syncProtocol.messageYjsSyncStep2
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for condition')
}

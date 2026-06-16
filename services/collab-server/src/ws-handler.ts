import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { WebSocket } from 'ws'
import type { AuthUser } from './upgrade-auth.js'
import { errorMessage, recordCollabServerEvent } from './audit-log.js'
import { getPersistence, loadOrCreateDoc, storeUpdate } from './persistence.js'

const MSG_SYNC = 0
const MSG_AWARENESS = 1
const SERVER_REPLACE_ORIGIN = Symbol('server_replace')
export const DOC_REPLACED_CLOSE_CODE = 4009
export const DOC_REPLACED_CLOSE_REASON = 'collab_doc_replaced'
export const AUTH_REVOKED_CLOSE_CODE = 4008
export const AUTH_REVOKED_CLOSE_REASON = 'collab_auth_revoked'
export const COLLAB_WS_RESOURCE_CLOSE_CODE = 1009
export const COLLAB_WS_MESSAGE_TOO_LARGE_REASON = 'collab_message_too_large'
export const COLLAB_WS_PENDING_QUEUE_EXCEEDED_REASON = 'collab_pending_queue_exceeded'
export const COLLAB_WS_RATE_LIMITED_REASON = 'collab_rate_limited'
export const COLLAB_WS_MAX_MESSAGE_BYTES = readPositiveIntEnv(
  'COLLAB_WS_MAX_MESSAGE_BYTES',
  256 * 1024,
)
export const COLLAB_WS_MAX_PENDING_MESSAGES = readPositiveIntEnv(
  'COLLAB_WS_MAX_PENDING_MESSAGES',
  64,
)
export const COLLAB_WS_MAX_PENDING_BYTES = readPositiveIntEnv(
  'COLLAB_WS_MAX_PENDING_BYTES',
  512 * 1024,
)
export const COLLAB_WS_RATE_WINDOW_MS = readPositiveIntEnv(
  'COLLAB_WS_RATE_WINDOW_MS',
  1000,
)
export const COLLAB_WS_MAX_MESSAGES_PER_WINDOW = readPositiveIntEnv(
  'COLLAB_WS_MAX_MESSAGES_PER_WINDOW',
  120,
)
export const COLLAB_WS_MAX_BYTES_PER_WINDOW = readPositiveIntEnv(
  'COLLAB_WS_MAX_BYTES_PER_WINDOW',
  1024 * 1024,
)

interface DocRoom {
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Map<WebSocket, Set<number>>
}

const rooms = new Map<string, DocRoom>()

export interface ReplaceDocTextResult {
  active: boolean
  length: number
  connectionsClosed: number
}

export interface InvalidateDocResult {
  active: boolean
  connectionsClosed: number
  cleared: boolean
}

export interface ConnectionGenerationOptions {
  clientGeneration?: number | null
  authoritativeGeneration?: number | null
  authorizeMessage?: () => boolean | Promise<boolean>
}

// Track which docs have active connections (for snapshot service).
export function getActiveDocIds(): string[] {
  return Array.from(rooms.entries())
    .filter(([, room]) => room.conns.size > 0)
    .map(([id]) => id)
}

export function getLoadedDocText(docId: string): string | null {
  const room = rooms.get(docId)
  if (!room) return null
  return room.doc.getText('content').toString()
}

export async function replaceDocText(docId: string, text: string): Promise<ReplaceDocTextResult> {
  const room = rooms.get(docId)
  if (room) {
    replaceYText(room.doc, text)
    await storeUpdate(docId, Y.encodeStateAsUpdate(room.doc))
    const connectionsClosed = closeRoomConnections(room, docId, 'doc_replace')
    void recordCollabServerEvent('doc_text_replaced', {
      docId,
      operation: 'doc_replace',
      details: { active: true, length: text.length, connections_closed: connectionsClosed },
    })
    return { active: true, length: text.length, connectionsClosed }
  }

  const doc = await getPersistence().getYDoc(docId)
  try {
    replaceYText(doc, text)
    await storeUpdate(docId, Y.encodeStateAsUpdate(doc))
    void recordCollabServerEvent('doc_text_replaced', {
      docId,
      operation: 'doc_replace',
      details: { active: false, length: text.length },
    })
    return { active: false, length: text.length, connectionsClosed: 0 }
  } finally {
    doc.destroy()
  }
}

export async function invalidateDoc(docId: string): Promise<InvalidateDocResult> {
  const room = rooms.get(docId)
  const connectionsClosed = room
    ? closeRoomConnections(room, docId, 'doc_invalidate')
    : 0
  await (getPersistence() as unknown as {
    clearDocument: (name: string) => Promise<void>
  }).clearDocument(docId)
  void recordCollabServerEvent('doc_invalidated', {
    docId,
    operation: 'doc_invalidate',
    details: { active: Boolean(room), connections_closed: connectionsClosed, cleared: true },
  })
  return { active: Boolean(room), connectionsClosed, cleared: true }
}

async function getOrCreateRoom(docId: string, token?: string): Promise<DocRoom> {
  let room = rooms.get(docId)
  if (room) return room

  const doc = await loadOrCreateDoc(docId, token)
  const awareness = new awarenessProtocol.Awareness(doc)

  awareness.on('update', (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
  ) => {
    const changedClients = added.concat(updated, removed)
    const room = rooms.get(docId)
    if (!room) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
    )
    const msg = encoding.toUint8Array(encoder)
    for (const [conn] of room.conns) {
      if (conn.readyState === 1) conn.send(msg)
    }
  })

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const room = rooms.get(docId)
    if (!room) return
    // Broadcast to all clients except the origin.
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    const msg = encoding.toUint8Array(encoder)
    for (const [conn] of room.conns) {
      if (conn !== origin && conn.readyState === 1) conn.send(msg)
    }
    // Persist the update.
    if (origin !== SERVER_REPLACE_ORIGIN) {
      void storeUpdate(docId, update).catch((err: unknown) => {
        void recordCollabServerEvent('update_persist_failed', {
          level: 'error',
          docId,
          operation: 'store_update',
          code: 'update_persist_failed',
          message: errorMessage(err),
          details: { update_bytes: update.byteLength },
        })
      })
    }
  })

  room = { doc, awareness, conns: new Map() }
  rooms.set(docId, room)
  void recordCollabServerEvent('room_created', {
    docId,
    operation: 'room_create',
  })
  return room
}

export function setupWSConnection(
  ws: WebSocket,
  docId: string,
  user: AuthUser,
  token: string,
  generationOptions: ConnectionGenerationOptions = {},
): void {
  if (!isCurrentGeneration(generationOptions)) {
    void recordCollabServerEvent('stale_generation_rejected', {
      level: 'warning',
      docId,
      userId: user.id,
      operation: 'websocket_connect',
      code: 'stale_collab_generation',
      details: {
        client_generation: generationOptions.clientGeneration,
        authoritative_generation: generationOptions.authoritativeGeneration,
      },
    })
    if (ws.readyState === 1) {
      ws.close(DOC_REPLACED_CLOSE_CODE, DOC_REPLACED_CLOSE_REASON)
    }
    return
  }

  let room: DocRoom | null = null
  let closed = false
  let messageChain = Promise.resolve()
  const pendingMessages: Uint8Array[] = []
  let pendingMessageBytes = 0
  let rateWindowStartedAt = Date.now()
  let rateWindowMessages = 0
  let rateWindowBytes = 0

  ws.on('message', (data: ArrayBuffer | Buffer) => {
    if (closed || ws.readyState !== 1) return
    const buf = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data)
    if (!acceptMessage(buf)) return
    if (!room) {
      queuePendingMessage(buf)
      return
    }
    messageChain = messageChain.then(() => processMessage(buf, false)).catch((err: unknown) => {
      void recordCollabServerEvent('message_processing_failed', {
        level: 'error',
        docId,
        userId: user.id,
        operation: 'message',
        code: 'message_processing_failed',
        message: errorMessage(err),
        details: { bytes: buf.byteLength, queued: false },
      })
    })
  })

  ws.on('close', () => {
    closed = true
    if (room) handleClose(room, ws, docId)
  })

  void (async () => {
    let loadedRoom: DocRoom
    try {
      loadedRoom = await getOrCreateRoom(docId, token)
    } catch (err) {
      void recordCollabServerEvent('room_load_failed', {
        level: 'error',
        docId,
        userId: user.id,
        operation: 'room_load',
        code: 'room_load_failed',
        message: errorMessage(err),
      })
      if (ws.readyState === 1) {
        ws.close(1011, 'failed to load collaboration document')
      }
      return
    }
    if (closed) return
    room = loadedRoom
    const { doc, awareness } = room

    room.conns.set(ws, new Set())
    void recordCollabServerEvent('client_connected', {
      docId,
      userId: user.id,
      operation: 'websocket_connect',
      details: { connection_count: room.conns.size },
    })

    // Send sync step 1.
    const syncEncoder = encoding.createEncoder()
    encoding.writeVarUint(syncEncoder, MSG_SYNC)
    syncProtocol.writeSyncStep1(syncEncoder, doc)
    ws.send(encoding.toUint8Array(syncEncoder))

    // Send current awareness states.
    const awarenessStates = awareness.getStates()
    if (awarenessStates.size > 0) {
      const awarenessEncoder = encoding.createEncoder()
      encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS)
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(
          awareness,
          Array.from(awarenessStates.keys()),
        ),
      )
      ws.send(encoding.toUint8Array(awarenessEncoder))
    }

    const queuedMessages = pendingMessages.splice(0)
    pendingMessageBytes = 0
    for (const pending of queuedMessages) {
      await processMessage(pending, true)
      if (closed) break
    }
  })()

  function acceptMessage(buf: Uint8Array): boolean {
    if (buf.byteLength > COLLAB_WS_MAX_MESSAGE_BYTES) {
      closeForResourceLimit(COLLAB_WS_MESSAGE_TOO_LARGE_REASON, {
        bytes: buf.byteLength,
        max_bytes: COLLAB_WS_MAX_MESSAGE_BYTES,
      })
      return false
    }
    return consumeRateBudget(buf)
  }

  function consumeRateBudget(buf: Uint8Array): boolean {
    const now = Date.now()
    if (now - rateWindowStartedAt >= COLLAB_WS_RATE_WINDOW_MS) {
      rateWindowStartedAt = now
      rateWindowMessages = 0
      rateWindowBytes = 0
    }

    rateWindowMessages += 1
    rateWindowBytes += buf.byteLength
    if (
      rateWindowMessages > COLLAB_WS_MAX_MESSAGES_PER_WINDOW
      || rateWindowBytes > COLLAB_WS_MAX_BYTES_PER_WINDOW
    ) {
      closeForResourceLimit(COLLAB_WS_RATE_LIMITED_REASON, {
        window_ms: COLLAB_WS_RATE_WINDOW_MS,
        messages: rateWindowMessages,
        bytes: rateWindowBytes,
        max_messages: COLLAB_WS_MAX_MESSAGES_PER_WINDOW,
        max_bytes: COLLAB_WS_MAX_BYTES_PER_WINDOW,
      })
      return false
    }
    return true
  }

  function queuePendingMessage(buf: Uint8Array): boolean {
    const nextCount = pendingMessages.length + 1
    const nextBytes = pendingMessageBytes + buf.byteLength
    if (
      nextCount > COLLAB_WS_MAX_PENDING_MESSAGES
      || nextBytes > COLLAB_WS_MAX_PENDING_BYTES
    ) {
      closeForResourceLimit(COLLAB_WS_PENDING_QUEUE_EXCEEDED_REASON, {
        queued_messages: nextCount,
        queued_bytes: nextBytes,
        max_messages: COLLAB_WS_MAX_PENDING_MESSAGES,
        max_bytes: COLLAB_WS_MAX_PENDING_BYTES,
      })
      return false
    }
    pendingMessages.push(buf)
    pendingMessageBytes = nextBytes
    return true
  }

  function closeForResourceLimit(reason: string, details: Record<string, unknown>): void {
    closed = true
    pendingMessages.length = 0
    pendingMessageBytes = 0
    void recordCollabServerEvent('websocket_resource_limit_exceeded', {
      level: 'warning',
      docId,
      userId: user.id,
      operation: 'message',
      code: reason,
      details,
    })
    if (ws.readyState === 1) {
      ws.close(COLLAB_WS_RESOURCE_CLOSE_CODE, reason)
    }
  }

  async function processMessage(buf: Uint8Array, queued: boolean): Promise<void> {
    if (!room || closed || ws.readyState !== 1) return
    if (!(await authorizeMessage(buf, queued))) return
    try {
      handleMessage(room, ws, buf, docId)
    } catch (err) {
      void recordCollabServerEvent('message_handling_failed', {
        level: 'error',
        docId,
        userId: user.id,
        operation: 'message',
        code: 'message_handling_failed',
        message: errorMessage(err),
        details: { bytes: buf.byteLength, queued },
      })
    }
  }

  async function authorizeMessage(buf: Uint8Array, queued: boolean): Promise<boolean> {
    const check = generationOptions.authorizeMessage
    if (!check) return true
    let authorized = false
    try {
      authorized = await check()
    } catch (err) {
      void recordCollabServerEvent('message_authorization_failed', {
        level: 'warning',
        docId,
        userId: user.id,
        operation: 'message_auth',
        code: 'collab_auth_check_failed',
        message: errorMessage(err),
        details: { bytes: buf.byteLength, queued },
      })
    }
    if (authorized) return true
    void recordCollabServerEvent('message_authorization_revoked', {
      level: 'warning',
      docId,
      userId: user.id,
      operation: 'message_auth',
      code: 'collab_auth_revoked',
      details: { bytes: buf.byteLength, queued },
    })
    if (ws.readyState === 1) {
      ws.close(AUTH_REVOKED_CLOSE_CODE, AUTH_REVOKED_CLOSE_REASON)
    }
    return false
  }
}

function isCurrentGeneration(options: ConnectionGenerationOptions): boolean {
  if (options.authoritativeGeneration === undefined || options.authoritativeGeneration === null) {
    return true
  }
  return Number.isSafeInteger(options.clientGeneration)
    && options.clientGeneration === options.authoritativeGeneration
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function closeRoomConnections(room: DocRoom, docId: string, operation: string): number {
  let closed = 0
  for (const [conn] of room.conns) {
    if (conn.readyState === 1) {
      conn.close(DOC_REPLACED_CLOSE_CODE, DOC_REPLACED_CLOSE_REASON)
      closed += 1
    }
  }
  if (closed > 0) {
    void recordCollabServerEvent('room_connections_reset', {
      docId,
      operation,
      details: { connections_closed: closed },
    })
  }
  return closed
}

function handleMessage(room: DocRoom, ws: WebSocket, buf: Uint8Array, docId: string): void {
  const { doc, awareness } = room
  const decoder = decoding.createDecoder(buf)
  const msgType = decoding.readVarUint(decoder)

  switch (msgType) {
    case MSG_SYNC: {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      syncProtocol.readSyncMessage(decoder, encoder, doc, ws)
      const reply = encoding.toUint8Array(encoder)
      if (encoding.length(encoder) > 1) {
        ws.send(reply)
      }
      break
    }
    case MSG_AWARENESS: {
      const update = decoding.readVarUint8Array(decoder)
      const connClients = room.conns.get(ws)
      if (connClients) {
        for (const changedClient of readAwarenessClientIds(update)) {
          connClients.add(changedClient)
        }
      }
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        update,
        ws,
      )
      break
    }
    default:
      void recordCollabServerEvent('unknown_message_type', {
        level: 'warning',
        docId,
        operation: 'message',
        code: 'unknown_message_type',
        details: { message_type: msgType, bytes: buf.byteLength },
      })
  }
}

function handleClose(room: DocRoom, ws: WebSocket, docId: string): void {
  const { awareness } = room
  const connClients = room.conns.get(ws)
  room.conns.delete(ws)
  const removeClientIds = connClients ? Array.from(connClients) : []
  if (removeClientIds.length > 0) {
    awarenessProtocol.removeAwarenessStates(awareness, removeClientIds, null)
  }
  void recordCollabServerEvent('client_disconnected', {
    docId,
    operation: 'websocket_disconnect',
    details: {
      connection_count: room.conns.size,
      awareness_clients_removed: removeClientIds.length,
    },
  })

  // If no more connections, clean up after a delay.
  if (room.conns.size === 0) {
    const cleanupTimer = setTimeout(() => {
      const current = rooms.get(docId)
      if (current && current.conns.size === 0) {
        current.doc.destroy()
        rooms.delete(docId)
        void recordCollabServerEvent('room_destroyed', {
          docId,
          operation: 'room_cleanup',
        })
      }
    }, 30_000)
    cleanupTimer.unref()
  }
}

function readAwarenessClientIds(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update)
  const count = decoding.readVarUint(decoder)
  const clientIds: number[] = []
  for (let i = 0; i < count; i++) {
    clientIds.push(decoding.readVarUint(decoder))
    decoding.readVarUint(decoder) // clock
    decoding.readVarString(decoder) // JSON state
  }
  return clientIds
}

function replaceYText(doc: Y.Doc, nextText: string): void {
  const yText = doc.getText('content')
  if (yText.toString() === nextText) {
    return
  }
  doc.transact(() => {
    yText.delete(0, yText.length)
    if (nextText) {
      yText.insert(0, nextText)
    }
  }, SERVER_REPLACE_ORIGIN)
}

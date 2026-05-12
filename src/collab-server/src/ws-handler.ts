import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { WebSocket } from 'ws'
import type { AuthUser } from './index.js'
import { loadOrCreateDoc, storeUpdate } from './persistence.js'

const MSG_SYNC = 0
const MSG_AWARENESS = 1

interface DocRoom {
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Map<WebSocket, Set<number>>
}

const rooms = new Map<string, DocRoom>()

// Track which docs have active connections (for snapshot service).
export function getActiveDocIds(): string[] {
  return Array.from(rooms.entries())
    .filter(([, room]) => room.conns.size > 0)
    .map(([id]) => id)
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
    void storeUpdate(docId, update)
  })

  room = { doc, awareness, conns: new Map() }
  rooms.set(docId, room)
  return room
}

export function setupWSConnection(ws: WebSocket, docId: string, user: AuthUser, token: string): void {
  void (async () => {
    const room = await getOrCreateRoom(docId, token)
    const { doc, awareness } = room

    const clientId = doc.clientID
    room.conns.set(ws, new Set())

    // Set awareness state for this user.
    const COLORS = [
      '#30bced', '#6eeb83', '#ffbc42', '#ecd444',
      '#ee6352', '#9ac2c9', '#8acb88', '#1be7ff',
    ]
    const colorIdx = Math.abs(hashCode(user.id)) % COLORS.length
    awareness.setLocalStateField('user', {
      id: user.id,
      name: user.name,
      color: COLORS[colorIdx],
      colorLight: COLORS[colorIdx] + '40',
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

    ws.on('message', (data: ArrayBuffer | Buffer) => {
      const buf = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data)
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
          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            decoding.readVarUint8Array(decoder),
            ws,
          )
          break
        }
      }
    })

    ws.on('close', () => {
      room.conns.delete(ws)
      awarenessProtocol.removeAwarenessStates(awareness, [clientId], null)

      // If no more connections, clean up after a delay.
      if (room.conns.size === 0) {
        setTimeout(() => {
          const current = rooms.get(docId)
          if (current && current.conns.size === 0) {
            current.doc.destroy()
            rooms.delete(docId)
          }
        }, 30_000)
      }
    })
  })()
}

function hashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

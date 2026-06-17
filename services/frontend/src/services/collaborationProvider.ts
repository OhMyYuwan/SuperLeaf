import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { Awareness } from 'y-protocols/awareness'
import { getRuntimeConfigValue, resolveWebSocketBase } from './runtimeConfig'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'synced'

export interface PeerInfo {
  id: string
  name: string
  color: string
  colorLight: string
  projectId?: string
  docId?: string
  cursorPos?: { anchor: number; head: number }
}

const COLLAB_PORT = import.meta.env.VITE_COLLAB_PORT ?? '4444'
const COLLAB_TOKEN_PROTOCOL_PREFIX = 'superleaf-collab-token.'
const COLLAB_GENERATION_PROTOCOL_PREFIX = 'superleaf-collab-generation.'
const DOC_REPLACED_CLOSE_CODE = 4009
const DOC_REPLACED_CLOSE_REASON = 'collab_doc_replaced'

function getCollabWsUrl(): string {
  const runtimeWsUrl = getRuntimeConfigValue('collabWsUrl')
  if (runtimeWsUrl !== undefined) {
    return resolveWebSocketBase(runtimeWsUrl)
  }
  if (import.meta.env.VITE_COLLAB_WS_URL) {
    return resolveWebSocketBase(import.meta.env.VITE_COLLAB_WS_URL)
  }
  if (typeof window !== 'undefined') {
    const { hostname } = window.location
    const host = hostname === 'localhost' ? '127.0.0.1' : hostname
    return `ws://${host}:${COLLAB_PORT}`
  }
  return `ws://127.0.0.1:${COLLAB_PORT}`
}

export class CollaborationProvider {
  readonly doc: Y.Doc
  readonly yText: Y.Text
  readonly awareness: Awareness
  readonly provider: WebsocketProvider
  readonly docGeneration: number

  private readonly projectId: string
  private readonly docId: string
  private _status: ConnectionStatus = 'disconnected'
  private _listeners = new Set<(status: ConnectionStatus) => void>()
  private _resetListeners = new Set<() => void>()

  constructor(
    projectId: string,
    docId: string,
    token: string,
    docGeneration: number,
    userInfo: { id: string; name: string; color: string },
  ) {
    this.projectId = projectId
    this.docId = docId
    this.docGeneration = docGeneration
    this.doc = new Y.Doc()
    this.yText = this.doc.getText('content')
    this.provider = new WebsocketProvider(
      getCollabWsUrl(),
      docId,
      this.doc,
      {
        connect: true,
        protocols: this._protocolsForToken(token),
      },
    )
    this.awareness = this.provider.awareness

    this.awareness.setLocalStateField('user', {
      id: userInfo.id,
      name: userInfo.name,
      color: userInfo.color,
      colorLight: userInfo.color + '40',
      projectId,
      docId,
    })

    this.provider.on('status', ({ status }: { status: string }) => {
      if (status === 'connected') {
        this._setStatus(this.isSynced() ? 'synced' : 'connected')
      } else if (status === 'disconnected') {
        this._setStatus('disconnected')
      } else {
        this._setStatus('connecting')
      }
    })

    this.provider.on('sync', (synced: boolean) => {
      if (synced) this._setStatus('synced')
    })

    this.provider.on('connection-close', (event: CloseEvent | null) => {
      if (
        event?.code === DOC_REPLACED_CLOSE_CODE
        || event?.reason === DOC_REPLACED_CLOSE_REASON
      ) {
        this._emitResetRequired()
      }
    })
  }

  get status(): ConnectionStatus {
    return this._status
  }

  isSynced(): boolean {
    return this._status === 'synced' || this.provider.synced
  }

  onStatusChange(fn: (status: ConnectionStatus) => void): () => void {
    this._listeners.add(fn)
    return () => { this._listeners.delete(fn) }
  }

  onResetRequired(fn: () => void): () => void {
    this._resetListeners.add(fn)
    return () => { this._resetListeners.delete(fn) }
  }

  getPeers(): PeerInfo[] {
    const peersByUserId = new Map<string, PeerInfo>()
    const ydoc = this.doc
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.doc.clientID) return
      const user = state.user as PeerInfo | undefined
      if (user?.projectId !== this.projectId || user?.docId !== this.docId) return
      if (user?.id && !peersByUserId.has(user.id)) {
        let cursorPos: { anchor: number; head: number } | undefined
        const cursor = state.cursor as { anchor: unknown; head: unknown } | null | undefined
        if (cursor?.anchor && cursor?.head) {
          const absAnchor = Y.createAbsolutePositionFromRelativePosition(cursor.anchor as Y.RelativePosition, ydoc)
          const absHead = Y.createAbsolutePositionFromRelativePosition(cursor.head as Y.RelativePosition, ydoc)
          if (absAnchor && absHead) {
            cursorPos = { anchor: absAnchor.index, head: absHead.index }
          }
        }
        peersByUserId.set(user.id, { ...user, cursorPos })
      }
    })
    return Array.from(peersByUserId.values())
  }

  refreshToken(token: string): void {
    this.provider.protocols = this._protocolsForToken(token)
    this.provider.disconnect()
    this.provider.connect()
    this._setStatus('connecting')
  }

  destroy(): void {
    this.provider.disconnect()
    this.provider.destroy()
    this.doc.destroy()
    this._listeners.clear()
    this._resetListeners.clear()
  }

  private _protocolsForToken(token: string): string[] {
    return [
      `${COLLAB_TOKEN_PROTOCOL_PREFIX}${token}`,
      `${COLLAB_GENERATION_PROTOCOL_PREFIX}${this.docGeneration}`,
    ]
  }

  private _setStatus(s: ConnectionStatus): void {
    if (this._status === s) return
    this._status = s
    for (const fn of this._listeners) fn(s)
  }

  private _emitResetRequired(): void {
    for (const fn of this._resetListeners) fn()
  }
}

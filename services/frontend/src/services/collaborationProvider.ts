import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { Awareness } from 'y-protocols/awareness'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'synced'

export interface PeerInfo {
  id: string
  name: string
  color: string
  colorLight: string
}

const COLLAB_PORT = import.meta.env.VITE_COLLAB_PORT ?? '4444'

function getCollabWsUrl(): string {
  if (import.meta.env.VITE_COLLAB_WS_URL) {
    return import.meta.env.VITE_COLLAB_WS_URL
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

  private _status: ConnectionStatus = 'disconnected'
  private _listeners = new Set<(status: ConnectionStatus) => void>()

  constructor(
    docId: string,
    token: string,
    userInfo: { id: string; name: string; color: string },
  ) {
    this.doc = new Y.Doc()
    this.yText = this.doc.getText('content')
    this.provider = new WebsocketProvider(
      getCollabWsUrl(),
      docId,
      this.doc,
      {
        connect: true,
        params: { token },
      },
    )
    this.awareness = this.provider.awareness

    this.awareness.setLocalStateField('user', {
      id: userInfo.id,
      name: userInfo.name,
      color: userInfo.color,
      colorLight: userInfo.color + '40',
    })

    this.provider.on('status', ({ status }: { status: string }) => {
      if (status === 'connected') {
        this._setStatus('connected')
      } else if (status === 'disconnected') {
        this._setStatus('disconnected')
      } else {
        this._setStatus('connecting')
      }
    })

    this.provider.on('sync', (synced: boolean) => {
      if (synced) this._setStatus('synced')
    })
  }

  get status(): ConnectionStatus {
    return this._status
  }

  onStatusChange(fn: (status: ConnectionStatus) => void): () => void {
    this._listeners.add(fn)
    return () => { this._listeners.delete(fn) }
  }

  getPeers(): PeerInfo[] {
    const peersByUserId = new Map<string, PeerInfo>()
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.doc.clientID) return
      const user = state.user as PeerInfo | undefined
      if (user?.id && !peersByUserId.has(user.id)) {
        peersByUserId.set(user.id, user)
      }
    })
    return Array.from(peersByUserId.values())
  }

  destroy(): void {
    this.provider.disconnect()
    this.provider.destroy()
    this.doc.destroy()
    this._listeners.clear()
  }

  private _setStatus(s: ConnectionStatus): void {
    if (this._status === s) return
    this._status = s
    for (const fn of this._listeners) fn(s)
  }
}

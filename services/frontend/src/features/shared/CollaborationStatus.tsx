/**
 * CollaborationStatus — 文档级协作者状态指示器
 *
 * - 30s stale 缓冲防止头像闪烁（连接抖动时延迟移除）
 * - 点击协作者头像跳转到其编辑光标位置
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useCollaborationStore } from '../../stores/collaborationStore'
import { useEditorStore } from '../../stores/editorStore'
import { useDocumentStore } from '../../stores/documentStore'
import type { ConnectionStatus, PeerInfo } from '../../services/collaborationProvider'
import './collaboration-status.css'

/** How long a disappeared peer stays visible (semi-transparent) before removal. */
const STALE_TTL_MS = 30_000

interface CachedPeer {
  peer: PeerInfo
  staleAt: number | null // null = fresh; number = timestamp when it should be removed
}

export function CollaborationStatus() {
  const status = useCollaborationStore((s) => s.status)
  const peers = useCollaborationStore((s) => s.peers)
  const [cachedPeers, setCachedPeers] = useState<Map<string, CachedPeer>>(new Map())
  const cacheRef = useRef<Map<string, CachedPeer>>(new Map())

  useEffect(() => { cacheRef.current = cachedPeers }, [cachedPeers])

  // Debounce peer list: mark disappeared peers as stale instead of removing immediately
  useEffect(() => {
    const now = Date.now()
    const peerIds = new Set(peers.map((p) => p.id))
    const next = new Map<string, CachedPeer>()

    // Add/update current peers
    for (const peer of peers) {
      next.set(peer.id, { peer, staleAt: null })
    }

    // Keep disappeared peers as stale (if within TTL)
    for (const [id, cached] of cacheRef.current) {
      if (!peerIds.has(id)) {
        if (cached.staleAt === null) {
          next.set(id, { ...cached, staleAt: now + STALE_TTL_MS })
        } else if (now < cached.staleAt) {
          next.set(id, cached)
        }
      }
    }

    setCachedPeers(next)
  }, [peers])

  // Periodically clean up expired stale peers
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      let changed = false
      const next = new Map(cacheRef.current)
      for (const [id, cached] of next) {
        if (cached.staleAt !== null && now >= cached.staleAt) {
          next.delete(id)
          changed = true
        }
      }
      if (changed) setCachedPeers(next)
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleClick = useCallback((peerId: string) => {
    const cached = cacheRef.current.get(peerId)
    if (!cached?.peer.cursorPos) return

    const peer = cached.peer
    const editorStore = useEditorStore.getState()
    const activeDocId = useDocumentStore.getState().activeDocumentId

    if (peer.docId && peer.docId !== activeDocId) {
      useDocumentStore.getState().setActive(peer.docId)
      setTimeout(() => {
        editorStore.setScrollTo({
          documentId: peer.docId!,
          pos: peer.cursorPos!.head,
          seq: Date.now(),
        })
      }, 300)
    } else {
      const docId = peer.docId ?? activeDocId
      if (!docId) return
      editorStore.setScrollTo({
        documentId: docId,
        pos: peer.cursorPos.head,
        seq: Date.now(),
      })
    }
  }, [])

  if (status === 'disconnected') return null

  const entries = Array.from(cachedPeers.values())

  return (
    <div className="collab-status">
      <span className={`collab-dot ${dotClass(status)}`} title={labelFor(status)} />
      {entries.length > 0 && (
        <div className="collab-peers">
          {entries.map((entry) => (
            <span
              key={entry.peer.id}
              className={`collab-peer-chip${entry.staleAt !== null ? ' stale' : ''}${entry.peer.cursorPos ? ' clickable' : ''}`}
              style={{ borderColor: entry.peer.color }}
              title={entry.peer.name}
              onClick={entry.peer.cursorPos ? () => handleClick(entry.peer.id) : undefined}
            >
              {entry.peer.name.charAt(0).toUpperCase()}
            </span>
          ))}
        </div>
      )}
      {status === 'connecting' && <span className="collab-label">连接中...</span>}
    </div>
  )
}

function dotClass(status: ConnectionStatus): string {
  switch (status) {
    case 'synced': return 'green'
    case 'connected': return 'yellow'
    case 'connecting': return 'yellow pulse'
    default: return 'red'
  }
}

function labelFor(status: ConnectionStatus): string {
  switch (status) {
    case 'synced': return '已同步'
    case 'connected': return '已连接'
    case 'connecting': return '连接中'
    default: return '未连接'
  }
}

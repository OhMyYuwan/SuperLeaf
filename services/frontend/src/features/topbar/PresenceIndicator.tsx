/**
 * PresenceIndicator — 显示当前在线协作成员的头像
 *
 * - 10s 轮询 + 30s stale 缓冲防止头像闪烁
 * - 点击头像跳转到该协作者的编辑光标位置
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { http } from '../../services/backendApi'
import { useProjectStore } from '../../stores/projectStore'
import { useCollaborationStore } from '../../stores/collaborationStore'
import { useEditorStore } from '../../stores/editorStore'
import { useDocumentStore } from '../../stores/documentStore'
import './presence-indicator.css'

interface OnlineUser {
  user_id: string
  display_name: string
}

/** How long a disappeared user stays visible (semi-transparent) before removal. */
const STALE_TTL_MS = 30_000
/** Polling interval for the online-users endpoint. */
const POLL_INTERVAL_MS = 10_000

interface CachedUser {
  user: OnlineUser
  staleAt: number | null // null = fresh; number = timestamp when it should be removed
}

export function PresenceIndicator() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const [cachedUsers, setCachedUsers] = useState<Map<string, CachedUser>>(new Map())
  const cacheRef = useRef<Map<string, CachedUser>>(new Map())

  // Keep cacheRef in sync
  useEffect(() => { cacheRef.current = cachedUsers }, [cachedUsers])

  useEffect(() => {
    if (!currentProjectId) {
      setCachedUsers(new Map())
      return
    }
    loadOnline()
    const interval = setInterval(loadOnline, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [currentProjectId])

  const loadOnline = async () => {
    if (!currentProjectId) return
    let data: OnlineUser[]
    try {
      data = await http<OnlineUser[]>(
        `/api/projects/${encodeURIComponent(currentProjectId)}/online`,
        { scope: 'global' },
      )
    } catch {
      return
    }

    const now = Date.now()
    const returnedIds = new Set(data.map((u) => u.user_id))
    const next = new Map<string, CachedUser>()

    // Add/update returned users
    for (const user of data) {
      next.set(user.user_id, { user, staleAt: null })
    }

    // Keep disappeared users as stale (if within TTL)
    for (const [id, cached] of cacheRef.current) {
      if (!returnedIds.has(id)) {
        if (cached.staleAt === null) {
          // Just disappeared — mark stale
          next.set(id, { ...cached, staleAt: now + STALE_TTL_MS })
        } else if (now < cached.staleAt) {
          // Still within TTL — keep
          next.set(id, cached)
        }
        // else: expired — drop
      }
    }

    setCachedUsers(next)
  }

  const handleClick = useCallback((userId: string) => {
    const peers = useCollaborationStore.getState().peers
    const peer = peers.find((p) => p.id === userId)
    if (!peer?.cursorPos) return

    const editorStore = useEditorStore.getState()
    const activeDocId = useDocumentStore.getState().activeDocumentId

    if (peer.docId && peer.docId !== activeDocId) {
      // Cross-document: switch document first, then scroll after collab connects
      useDocumentStore.getState().setActive(peer.docId)
      // Use a small delay to let the document switch and collab connect
      setTimeout(() => {
        editorStore.setScrollTo({
          documentId: peer.docId!,
          pos: peer.cursorPos!.head,
          seq: Date.now(),
        })
      }, 300)
    } else {
      // Same document: scroll directly
      const docId = peer.docId ?? activeDocId
      if (!docId) return
      editorStore.setScrollTo({
        documentId: docId,
        pos: peer.cursorPos.head,
        seq: Date.now(),
      })
    }
  }, [])

  const entries = Array.from(cachedUsers.values())
  if (entries.length === 0) return null

  return (
    <div className="presence-indicator" title={entries.map((e) => e.user.display_name).join(', ')}>
      {entries.slice(0, 4).map((entry) => (
        <div
          key={entry.user.user_id}
          className={`presence-avatar${entry.staleAt !== null ? ' stale' : ''}`}
          title={entry.user.display_name}
          onClick={() => handleClick(entry.user.user_id)}
        >
          {getInitial(entry.user.display_name)}
        </div>
      ))}
      {entries.length > 4 && (
        <div className="presence-avatar presence-more">+{entries.length - 4}</div>
      )}
    </div>
  )
}

function getInitial(name: string): string {
  if (!name) return '?'
  return name.charAt(0).toUpperCase()
}

import { create } from 'zustand'
import {
  CollaborationProvider,
  type ConnectionStatus,
  type PeerInfo,
} from '../services/collaborationProvider'
import { http } from '../services/backendApi'

const COLORS = [
  '#30bced', '#6eeb83', '#ffbc42', '#ecd444',
  '#ee6352', '#9ac2c9', '#8acb88', '#1be7ff',
]

function colorForUser(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0
  }
  return COLORS[Math.abs(hash) % COLORS.length]
}

interface CollaborationState {
  provider: CollaborationProvider | null
  status: ConnectionStatus
  peers: PeerInfo[]
  currentProjectId: string | null
  currentDocId: string | null

  connect: (projectId: string, docId: string, user: { id: string; name: string }) => Promise<void>
  disconnect: () => void
  waitUntilSynced: (docId: string, timeoutMs?: number) => Promise<void>
  getCurrentText: (docId: string) => string | null
}

interface CollabTokenResponse {
  token: string
  expires_in: number
  collab_generation: number
}

async function issueCollabToken(docId: string): Promise<CollabTokenResponse> {
  return await http<CollabTokenResponse>(
    `/api/auth/collab-token?doc_id=${encodeURIComponent(docId)}`,
  )
}

export const useCollaborationStore = create<CollaborationState>()((set, get) => ({
  provider: null,
  status: 'disconnected',
  peers: [],
  currentProjectId: null,
  currentDocId: null,

  connect: async (projectId, docId, user) => {
    const prev = get().provider
    if (prev) {
      prev.destroy()
    }
    set({ provider: null, status: 'connecting', peers: [], currentProjectId: projectId, currentDocId: docId })

    // Fetch a short-lived, document-scoped collab token from the backend.
    let token: CollabTokenResponse
    try {
      token = await issueCollabToken(docId)
    } catch {
      console.warn('[collaborationStore] failed to get collab token')
      set({ status: 'disconnected', provider: null, peers: [], currentProjectId: null, currentDocId: null })
      return
    }

    if (get().currentProjectId !== projectId || get().currentDocId !== docId) return

    const provider = new CollaborationProvider(projectId, docId, token.token, token.collab_generation, {
      id: user.id,
      name: user.name,
      color: colorForUser(user.id),
    })

    const reconnectFresh = () => {
      const state = get()
      if (state.provider !== provider || state.currentProjectId !== projectId || state.currentDocId !== docId) {
        return
      }
      void get().connect(projectId, docId, user)
    }

    provider.onResetRequired(reconnectFresh)

    // Proactive token refresh: fetches token periodically and caches it.
    // On connection-close, the cached token is applied SYNCHRONOUSLY to
    // provider.protocols, so y-websocket's auto-reconnect (which reads
    // protocols at execution time, not scheduling time) uses a fresh token.
    const refreshIntervalMs = Math.max(5_000, (token.expires_in * 1000) * 0.8)
    provider.setTokenRefresher(async () => {
      const t = await issueCollabToken(docId)
      if (get().provider !== provider || get().currentDocId !== docId) {
        throw new Error('stale provider')
      }
      if (t.collab_generation !== provider.docGeneration) {
        reconnectFresh()
        throw new Error('generation mismatch')
      }
      return t.token
    }, refreshIntervalMs)

    provider.onStatusChange((status) => {
      if (get().provider !== provider) return
      set({ status })
      // Token refresh is handled by connection-close callback (setTokenRefresher).
      // If auto-reconnect succeeds, status goes to 'connected'/'synced'.
      // If it keeps failing, the user sees 'disconnected' and can manually retry.
    })

    provider.awareness.on('change', () => {
      if (get().provider !== provider) return
      set({ peers: provider.getPeers() })
    })

    set({
      provider,
      status: provider.status,
      peers: [],
      currentProjectId: projectId,
      currentDocId: docId,
    })
  },

  disconnect: () => {
    const { provider } = get()
    if (provider) {
      provider.destroy()
    }
    set({ provider: null, status: 'disconnected', peers: [], currentProjectId: null, currentDocId: null })
  },

  waitUntilSynced: (docId, timeoutMs = 5000) => {
    const state = get()
    const provider = state.provider
    if (!provider || state.currentDocId !== docId) {
      return Promise.resolve()
    }
    if (state.status === 'synced' || provider.isSynced()) {
      if (state.status !== 'synced') {
        set({ status: 'synced' })
      }
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      let settled = false
      let unsubscribe: (() => void) | null = null
      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        if (unsubscribe) unsubscribe()
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      const timer = setTimeout(() => {
        finish(new Error('协作连接尚未同步，请稍后再保存'))
      }, timeoutMs)
      unsubscribe = provider.onStatusChange((status) => {
        const latest = get()
        const latestProvider = latest.provider
        if (latestProvider !== provider || latest.currentDocId !== docId) {
          finish()
          return
        }
        if (status === 'synced' || latestProvider.isSynced()) {
          finish()
        }
      })
      if (provider.isSynced()) {
        finish()
      }
    })
  },

  getCurrentText: (docId) => {
    const state = get()
    if (!state.provider || state.currentDocId !== docId) {
      return null
    }
    return state.provider.yText.toString()
  },
}))

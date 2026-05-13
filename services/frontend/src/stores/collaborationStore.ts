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
  currentDocId: string | null

  connect: (docId: string, user: { id: string; name: string }) => Promise<void>
  disconnect: () => void
}

export const useCollaborationStore = create<CollaborationState>()((set, get) => ({
  provider: null,
  status: 'disconnected',
  peers: [],
  currentDocId: null,

  connect: async (docId, user) => {
    const prev = get().provider
    if (prev) {
      prev.destroy()
    }

    // Fetch a collab token from the backend (echoes the session cookie).
    let token: string
    try {
      const res = await http<{ token: string }>('/api/auth/collab-token')
      token = res.token
    } catch {
      console.warn('[collaborationStore] failed to get collab token')
      set({ status: 'disconnected', provider: null, currentDocId: null })
      return
    }

    const provider = new CollaborationProvider(docId, token, {
      id: user.id,
      name: user.name,
      color: colorForUser(user.id),
    })

    provider.onStatusChange((status) => {
      set({ status })
    })

    provider.awareness.on('change', () => {
      set({ peers: provider.getPeers() })
    })

    set({
      provider,
      status: provider.status,
      peers: [],
      currentDocId: docId,
    })
  },

  disconnect: () => {
    const { provider } = get()
    if (provider) {
      provider.destroy()
    }
    set({ provider: null, status: 'disconnected', peers: [], currentDocId: null })
  },
}))

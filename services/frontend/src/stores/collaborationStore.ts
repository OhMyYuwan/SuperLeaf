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
    let token: string
    try {
      const res = await http<{ token: string; expires_in: number }>(
        `/api/auth/collab-token?doc_id=${encodeURIComponent(docId)}`,
      )
      token = res.token
    } catch {
      console.warn('[collaborationStore] failed to get collab token')
      set({ status: 'disconnected', provider: null, peers: [], currentProjectId: null, currentDocId: null })
      return
    }

    if (get().currentProjectId !== projectId || get().currentDocId !== docId) return

    const provider = new CollaborationProvider(projectId, docId, token, {
      id: user.id,
      name: user.name,
      color: colorForUser(user.id),
    })

    provider.onStatusChange((status) => {
      if (get().provider !== provider) return
      set({ status })
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
}))

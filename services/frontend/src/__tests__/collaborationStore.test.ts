import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCollaborationStore } from '../stores/collaborationStore'

describe('collaborationStore sync readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCollaborationStore.setState({
      provider: null,
      status: 'disconnected',
      peers: [],
      currentProjectId: null,
      currentDocId: null,
    })
  })

  it('treats the provider sync flag as authoritative when saving', async () => {
    const provider = {
      isSynced: () => true,
      onStatusChange: vi.fn(),
    }

    useCollaborationStore.setState({
      provider: provider as never,
      status: 'connected',
      peers: [],
      currentProjectId: 'project-1',
      currentDocId: 'doc-1',
    })

    await expect(useCollaborationStore.getState().waitUntilSynced('doc-1', 1)).resolves.toBeUndefined()
    expect(provider.onStatusChange).not.toHaveBeenCalled()
  })
})

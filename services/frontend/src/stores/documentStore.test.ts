import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useDocumentStore } from './documentStore'
import { useCollaborationStore } from './collaborationStore'
import { filesystemApi } from '../services/filesystemApi'
import type { Document } from '../types/document'

vi.mock('../services/filesystemApi', () => ({
  filesystemApi: {
    getDoc: vi.fn(),
    updateDoc: vi.fn(),
    flushCollabDoc: vi.fn(),
  },
}))

function seedDoc(id: string): Document {
  return {
    id,
    format: 'md',
    content: '# Title\n\npara',
    structure: { sections: [], paragraphs: [], citations: [] } as any,
    metadata: { title: 'a.md', author: 'user', created: new Date(), modified: new Date(), tags: [] },
    version: 1,
  }
}

describe('applyDocFormatChange', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    useDocumentStore.setState({
      documents: {},
      activeDocumentId: null,
      saveStatus: {},
      lastSavedAt: {},
      saveError: {},
      collaborating: {},
      backendVersions: {},
    } as any)
    useCollaborationStore.setState({
      provider: null,
      status: 'disconnected',
      peers: [],
      currentProjectId: null,
      currentDocId: null,
    } as any)
  })

  it('updates format and recomputes structure for an open doc', () => {
    useDocumentStore.setState({ documents: { d1: seedDoc('d1') } } as any)
    useDocumentStore.getState().applyDocFormatChange('d1', 'tex')
    const doc = useDocumentStore.getState().documents['d1']
    expect(doc.format).toBe('tex')
    // structure must be a fresh object (recomputed), not the seeded one
    expect(doc.structure).toBeDefined()
  })

  it('is a no-op when the doc is not open', () => {
    useDocumentStore.getState().applyDocFormatChange('missing', 'tex')
    expect(useDocumentStore.getState().documents['missing']).toBeUndefined()
  })

  it('is a no-op when format is unchanged', () => {
    const doc = seedDoc('d1')
    useDocumentStore.setState({ documents: { d1: doc } } as any)
    useDocumentStore.getState().applyDocFormatChange('d1', 'md')
    expect(useDocumentStore.getState().documents['d1']).toBe(doc)
  })

  it('does not REST-save local Yjs text when collab flush fails', async () => {
    const doc = seedDoc('doc-collab')
    useDocumentStore.setState({
      documents: { [doc.id]: doc },
      collaborating: { [doc.id]: true },
      saveStatus: { [doc.id]: 'dirty' },
      saveError: { [doc.id]: null },
      backendVersions: { [doc.id]: 1 },
    } as any)
    useCollaborationStore.setState({
      currentDocId: doc.id,
      provider: { yText: { toString: () => 'browser-only text' } },
      waitUntilSynced: vi.fn().mockResolvedValue(undefined),
      getCurrentText: vi.fn().mockReturnValue('browser-only text'),
    } as any)
    vi.mocked(filesystemApi.flushCollabDoc).mockRejectedValue(new Error('collab unavailable'))

    await useDocumentStore.getState().saveBackendDoc(doc.id)

    expect(filesystemApi.flushCollabDoc).toHaveBeenCalledWith(doc.id)
    expect(filesystemApi.updateDoc).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().saveStatus[doc.id]).toBe('error')
    expect(useDocumentStore.getState().saveError[doc.id]).toContain('collab unavailable')
  })

  it('retries authoritative collab flush after a save error', async () => {
    const doc = seedDoc('doc-retry')
    useDocumentStore.setState({
      documents: { [doc.id]: doc },
      collaborating: { [doc.id]: true },
      saveStatus: { [doc.id]: 'error' },
      saveError: { [doc.id]: 'previous failure' },
    } as any)
    useCollaborationStore.setState({
      currentDocId: doc.id,
      provider: { yText: { toString: () => 'server candidate text' } },
      waitUntilSynced: vi.fn().mockResolvedValue(undefined),
      getCurrentText: vi.fn().mockReturnValue('server candidate text'),
    } as any)
    vi.mocked(filesystemApi.flushCollabDoc).mockResolvedValue({
      id: doc.id,
      project_id: 'project-1',
      folder_id: null,
      name: 'main.tex',
      format: 'tex',
      content: 'server candidate text',
      version: 2,
      updated_at: new Date().toISOString(),
    })

    await useDocumentStore.getState().saveBackendDoc(doc.id)

    expect(filesystemApi.flushCollabDoc).toHaveBeenCalledTimes(1)
    expect(filesystemApi.updateDoc).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().saveStatus[doc.id]).toBe('saved')
  })
})

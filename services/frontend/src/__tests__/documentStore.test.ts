import { beforeEach, describe, expect, it, vi } from 'vitest'
import { filesystemApi, type BackendDoc } from '../services/filesystemApi'
import { useDocumentStore } from '../stores/documentStore'

vi.mock('../services/filesystemApi', () => ({
  filesystemApi: {
    getDoc: vi.fn(),
    updateDoc: vi.fn(),
    flushCollabDoc: vi.fn(),
  },
}))

vi.mock('../stores/_userScopedStorage', () => ({
  createUserScopedStorage: () => ({
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  }),
}))

vi.mock('../features/shared/toast', () => ({
  showToast: vi.fn(),
}))

const mockGetDoc = vi.mocked(filesystemApi.getDoc)
const mockUpdateDoc = vi.mocked(filesystemApi.updateDoc)
const mockFlushCollabDoc = vi.mocked(filesystemApi.flushCollabDoc)

function makeBackendDoc(overrides: Partial<BackendDoc> = {}): BackendDoc {
  return {
    id: 'doc-1',
    project_id: 'project-1',
    folder_id: null,
    name: 'main.tex',
    format: 'tex',
    content: '\\section{Intro}',
    version: 1,
    updated_at: '2026-05-25T08:00:00Z',
    ...overrides,
  }
}

describe('documentStore saved timestamps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDocumentStore.setState({
      documents: {},
      activeDocumentId: null,
      saveStatus: {},
      lastSavedAt: {},
      saveError: {},
      collaborating: {},
      backendVersions: {},
    })
  })

  it('keeps the same compile token when focus refresh returns unchanged backend content', async () => {
    const backendDoc = makeBackendDoc()
    useDocumentStore.getState().upsertFromBackendDoc(backendDoc)

    const firstSavedAt = useDocumentStore.getState().lastSavedAt['doc-1']
    mockGetDoc.mockResolvedValue(backendDoc)

    await useDocumentStore.getState().refreshFromBackend('doc-1')

    expect(mockGetDoc).toHaveBeenCalledWith('doc-1')
    expect(useDocumentStore.getState().lastSavedAt['doc-1']).toBe(firstSavedAt)
    expect(firstSavedAt).toBe(Date.parse('2026-05-25T08:00:00Z'))
  })

  it('advances the compile token from the backend timestamp returned by a real save', async () => {
    useDocumentStore.getState().upsertFromBackendDoc(makeBackendDoc())
    useDocumentStore.getState().updateContent('doc-1', '\\section{Changed}')

    mockUpdateDoc.mockResolvedValue(
      makeBackendDoc({
        content: '\\section{Changed}',
        version: 2,
        updated_at: '2026-05-25T08:05:00Z',
      }),
    )

    await useDocumentStore.getState().saveBackendDoc('doc-1')

    expect(mockUpdateDoc).toHaveBeenCalledWith('doc-1', '\\section{Changed}', 1)
    expect(useDocumentStore.getState().saveStatus['doc-1']).toBe('saved')
    expect(useDocumentStore.getState().lastSavedAt['doc-1']).toBe(
      Date.parse('2026-05-25T08:05:00Z'),
    )
  })

  it('flushes from collab-server instead of REST-saving stale local content while collaborating', async () => {
    useDocumentStore.getState().upsertFromBackendDoc(makeBackendDoc({ content: 'old', version: 7 }))
    useDocumentStore.getState().setCollaborating('doc-1', true)
    mockFlushCollabDoc.mockResolvedValue(
      makeBackendDoc({
        content: 'from yjs',
        version: 8,
        updated_at: '2026-05-25T08:10:00Z',
      }),
    )

    await useDocumentStore.getState().flushPendingSave('doc-1')

    expect(mockFlushCollabDoc).toHaveBeenCalledWith('doc-1')
    expect(mockUpdateDoc).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().documents['doc-1'].content).toBe('from yjs')
    expect(useDocumentStore.getState().documents['doc-1'].version).toBe(8)
    expect(useDocumentStore.getState().saveStatus['doc-1']).toBe('saved')
  })

  it('rejects a pending flush when collab-server save fails', async () => {
    useDocumentStore.getState().upsertFromBackendDoc(makeBackendDoc())
    useDocumentStore.getState().setCollaborating('doc-1', true)
    mockFlushCollabDoc.mockRejectedValue(new Error('collab unavailable'))

    await expect(useDocumentStore.getState().flushPendingSave('doc-1')).rejects.toThrow(
      'document save failed',
    )

    expect(mockUpdateDoc).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().saveStatus['doc-1']).toBe('error')
  })
})

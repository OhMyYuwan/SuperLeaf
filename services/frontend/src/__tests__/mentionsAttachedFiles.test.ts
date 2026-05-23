import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAgentPrompt, resolveAttachedFiles, type FileCandidate } from '../services/mentions'
import { filesystemApi } from '../services/filesystemApi'

vi.mock('../services/filesystemApi', () => ({
  filesystemApi: {
    getDoc: vi.fn(),
    fileUrl: vi.fn((id: string) => `/api/files/${id}`),
  },
}))

const mockGetDoc = vi.mocked(filesystemApi.getDoc)

function docCandidate(overrides: Partial<FileCandidate> = {}): FileCandidate {
  return {
    kind: 'file',
    id: 'doc-1',
    name: 'reference.md',
    path: 'references/reference.md',
    format: 'doc',
    size_bytes: 42,
    docFormat: 'md',
    ...overrides,
  }
}

describe('mentions attached files', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves document mentions into prompt content', async () => {
    mockGetDoc.mockResolvedValue({
      id: 'doc-1',
      project_id: 'project-1',
      folder_id: null,
      name: 'reference.md',
      format: 'md',
      content: 'Vaswani attention notes',
      version: 1,
      updated_at: '2026-05-21T00:00:00Z',
    })

    const files = await resolveAttachedFiles([docCandidate()])
    const prompt = buildAgentPrompt({
      targetText: 'selected text',
      userMessage: 'please use this file',
      threadHistory: [],
      attachedFiles: files,
    })

    expect(mockGetDoc).toHaveBeenCalledWith('doc-1')
    expect(files[0]).toMatchObject({
      kind: 'doc',
      content: 'Vaswani attention notes',
      path: 'references/reference.md',
    })
    expect(prompt).toContain('[ATTACHED FILES]')
    expect(prompt).toContain('[FILE: reference.md | kind=doc')
    expect(prompt).toContain('Vaswani attention notes')
    expect(prompt).toContain('主要回答直接用 Markdown')
  })

  it('adds concise replacement guidance with inferred document format', () => {
    const prompt = buildAgentPrompt({
      targetText: 'Existing paragraph without markup.',
      userMessage: 'please rewrite this',
      threadHistory: [],
      documentFormat: 'tex',
    })

    expect(prompt).toContain('不要输出 JSON')
    expect(prompt).toContain('代码块内容保持 LaTeX 源格式')
    expect(prompt).toContain('围栏语言建议：latex')
  })

  it('omits document content when the total attachment budget is exceeded', async () => {
    mockGetDoc.mockResolvedValue({
      id: 'doc-1',
      project_id: 'project-1',
      folder_id: null,
      name: 'reference.md',
      format: 'md',
      content: 'abcdef',
      version: 1,
      updated_at: '2026-05-21T00:00:00Z',
    })

    const files = await resolveAttachedFiles([docCandidate()], { totalBudget: 1 })

    expect(files[0]).toMatchObject({
      kind: 'doc',
      omitted: true,
      omit_reason: 'total attachment budget exceeded',
    })
    expect(files[0]).not.toHaveProperty('content')
  })
})

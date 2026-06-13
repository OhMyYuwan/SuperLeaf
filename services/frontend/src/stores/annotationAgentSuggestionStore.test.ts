import { beforeEach, describe, expect, it, vi } from 'vitest'
import { annotationAgentSuggestionApi } from '../services/annotationAgentSuggestionApi'
import { useAnnotationAgentSuggestionStore } from './annotationAgentSuggestionStore'

vi.mock('../services/annotationAgentSuggestionApi', () => ({
  annotationAgentSuggestionApi: {
    run: vi.fn(),
    listByDoc: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

vi.mock('../features/shared/toast', () => ({
  showToast: vi.fn(),
}))

const run = vi.mocked(annotationAgentSuggestionApi.run)

describe('annotationAgentSuggestionStore.runAutoReply', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAnnotationAgentSuggestionStore.setState({
      suggestionsByAnnotation: {},
      runningByDoc: {},
      lastRunByDoc: {},
      error: null,
    })
    run.mockResolvedValue({
      processed: 0,
      skipped: 0,
      failed: 0,
      suggestions: [],
    })
  })

  it('sends target kind with the selected auto-reply target', async () => {
    await useAnnotationAgentSuggestionStore.getState().runAutoReply(
      'doc-1',
      'workflow-1',
      { includeStale: false, targetKind: 'workflow' },
    )

    expect(run).toHaveBeenCalledWith({
      doc_id: 'doc-1',
      agent_id: 'workflow-1',
      target_kind: 'workflow',
      include_stale: false,
      scope: 'current_doc',
    })
  })
})

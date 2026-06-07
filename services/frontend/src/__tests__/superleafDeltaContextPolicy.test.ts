import { describe, expect, it } from 'vitest'
import type { BrowserCodexPrepare } from '../services/backendApi'
import {
  applyCodexDeltaContext,
  forceCodexDeltaContextUnchanged,
} from '../services/superleafDeltaContextPolicy'

function prepared(
  patch: Partial<BrowserCodexPrepare> = {},
): BrowserCodexPrepare {
  return {
    run_id: 'run_1',
    provider_id: 'provider_1',
    endpoint: 'http://127.0.0.1:8787',
    model: 'gpt-5-codex',
    system_prompt: '',
    prompt: 'Improve this.',
    tools: [],
    user_message: {
      id: 'msg_1',
      conversation_id: 'conv_1',
      role: 'user',
      content: 'Improve this.',
      range_start: 10,
      range_end: 20,
      external_message_id: '',
      error: '',
      created_at: '2026-06-07T00:00:00Z',
    },
    document_id: 'doc_1',
    range_start: 10,
    range_end: 20,
    workspace_path: '/tmp/project',
    prompt_mode: 'fast-edit',
    codex_settings: {
      prompt_mode: 'fast-edit',
      tool_mode: 'mcp-first',
      context_mode: 'lease',
    },
    superleaf_context: {
      project_id: 'project_1',
      conversation_id: 'conv_1',
      document_id: 'doc_1',
      doc_version: 'v1',
      range_start: 10,
      range_end: 20,
      selection_hash: 'hash_a',
      selection_preview: 'selected text',
      tool_manifest_version: 'superleaf-tools@1',
    },
    inputs: {},
    ...patch,
  }
}

describe('superleafDeltaContextPolicy', () => {
  it('marks the first selected context as a selection delta', () => {
    const result = applyCodexDeltaContext(prepared())

    expect(result.changed).toBe('selection')
    expect(result.snapshot.contextHash).toMatch(/^slctxh_[0-9a-f]{8}$/u)
    expect(result.prepared.superleaf_context.context_changed).toBe('selection')
    expect(result.prepared.superleaf_context.context_hash).toBe(result.snapshot.contextHash)
  })

  it('marks unchanged follow-up context as none', () => {
    const first = applyCodexDeltaContext(prepared())
    const second = applyCodexDeltaContext(prepared(), first.snapshot)

    expect(second.changed).toBe('none')
    expect(second.prepared.superleaf_context.context_changed).toBe('none')
    expect(second.snapshot.contextHash).toBe(first.snapshot.contextHash)
  })

  it('detects selection and range changes', () => {
    const first = applyCodexDeltaContext(prepared())
    const changedSelection = applyCodexDeltaContext(prepared({
      range_start: 12,
      range_end: 24,
      superleaf_context: {
        ...prepared().superleaf_context,
        range_start: 12,
        range_end: 24,
        selection_hash: 'hash_b',
      },
    }), first.snapshot)

    expect(changedSelection.changed).toBe('selection')
  })

  it('detects document and tool manifest changes', () => {
    const first = applyCodexDeltaContext(prepared())
    const changedDocument = applyCodexDeltaContext(prepared({
      superleaf_context: {
        ...prepared().superleaf_context,
        doc_version: 'v2',
      },
    }), first.snapshot)
    const changedTools = applyCodexDeltaContext(prepared({
      superleaf_context: {
        ...prepared().superleaf_context,
        tool_manifest_version: 'superleaf-tools@2',
      },
    }), first.snapshot)

    expect(changedDocument.changed).toBe('document')
    expect(changedTools.changed).toBe('tools')
  })

  it('can force repeated tool-result rounds to unchanged', () => {
    const first = applyCodexDeltaContext(prepared())
    const unchanged = forceCodexDeltaContextUnchanged(first.prepared)

    expect(unchanged.superleaf_context.context_changed).toBe('none')
    expect(unchanged.superleaf_context.context_hash).toBe(first.snapshot.contextHash)
  })
})

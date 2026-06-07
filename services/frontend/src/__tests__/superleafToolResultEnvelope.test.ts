import { describe, expect, it } from 'vitest'
import type { BrowserNanobotToolResult } from '../services/backendApi'
import {
  normalizeBrowserToolResultForAgent,
  toolResultEnvelopeFields,
} from '../services/superleafToolResultEnvelope'

function result(patch: Partial<BrowserNanobotToolResult> = {}): BrowserNanobotToolResult {
  return {
    role: 'tool',
    tool_call_id: 'call_1',
    content: '{"status":"proposed","original_text":"long ui payload"}',
    failed: false,
    name: 'propose_doc_edit',
    tool_kind: 'edit_proposal',
    events: [],
    ...patch,
  }
}

describe('superleafToolResultEnvelope', () => {
  it('uses model_visible content when the backend provides an envelope', () => {
    const normalized = normalizeBrowserToolResultForAgent(result({
      model_visible: {
        status: 'ok',
        summary: 'Edit proposal created in SuperLeaf.',
      },
      ui_meta: {
        side_event: {
          event: 'native.agent.edit_proposal',
          data: { proposal_id: 'prop_1' },
        },
      },
      audit: {
        tool_call_id: 'call_1',
      },
    }))

    expect(normalized.content).toBe(JSON.stringify({
      status: 'ok',
      summary: 'Edit proposal created in SuperLeaf.',
    }))
    expect(normalized.content).not.toContain('original_text')
    expect(normalized.ui_meta?.side_event).toBeTruthy()
  })

  it('compacts legacy proposal side events for model-visible content', () => {
    const normalized = normalizeBrowserToolResultForAgent(result({
      events: [
        {
          event: 'ylw.msg.edit_proposal',
          data: {
            proposal_id: 'prop_1',
            document_id: 'doc_1',
            original_text: 'full original text',
            new_text: 'replacement text',
          },
        },
      ],
    }))

    expect(normalized.content).toContain('Edit proposal created in SuperLeaf')
    expect(normalized.content).toContain('prop_1')
    expect(normalized.content).not.toContain('full original text')
    expect(normalized.ui_meta?.side_event).toBeTruthy()
  })

  it('keeps read tool content model-visible', () => {
    const normalized = normalizeBrowserToolResultForAgent(result({
      name: 'project_read_doc',
      tool_kind: 'project_context',
      content: '{"doc_id":"doc_1","content":"paper text"}',
    }))

    expect(normalized.content).toBe('{"doc_id":"doc_1","content":"paper text"}')
  })

  it('exposes envelope fields for MCP bridge submission', () => {
    const fields = toolResultEnvelopeFields(result({
      model_visible: { status: 'ok', summary: 'done' },
      ui_meta: { card: 'proposal' },
      audit: { tool_call_id: 'call_1' },
    }))

    expect(fields.model_visible.summary).toBe('done')
    expect(fields.ui_meta.card).toBe('proposal')
    expect(fields.audit.tool_call_id).toBe('call_1')
  })
})

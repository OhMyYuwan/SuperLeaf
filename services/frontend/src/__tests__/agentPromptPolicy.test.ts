import { describe, expect, it } from 'vitest'
import type { BrowserCodexPrepare } from '../services/backendApi'
import {
  buildCodexPromptWithPolicy,
  codexEffectiveApprovalPolicy,
  shouldUseCodexLeasePrompt,
} from '../services/agentPromptPolicy'

function prepared(
  patch: Partial<BrowserCodexPrepare> = {},
): BrowserCodexPrepare {
  return {
    run_id: 'run_1',
    provider_id: 'provider_1',
    endpoint: 'http://127.0.0.1:8787',
    model: 'gpt-5-codex',
    system_prompt: 'Use SuperLeaf tools.',
    prompt: 'Please improve the selected sentence.',
    tools: [
      {
        type: 'function',
        function: {
          name: 'propose_doc_edit',
          description: 'Create a SuperLeaf edit proposal.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    user_message: {
      id: 'msg_1',
      conversation_id: 'conv_1',
      role: 'user',
      content: 'Please improve the selected sentence.',
      range_start: 10,
      range_end: 20,
      external_message_id: '',
      error: '',
      created_at: '2026-06-06T00:00:00Z',
    },
    document_id: 'doc_1',
    range_start: 10,
    range_end: 20,
    workspace_path: '/tmp/project',
    prompt_mode: 'fast-edit',
    codex_settings: {
      prompt_mode: 'fast-edit',
      tool_mode: 'mcp-first',
      context_mode: 'legacy-blocks',
    },
    superleaf_context: {
      project_id: 'project_1',
      conversation_id: 'conv_1',
      document_id: 'doc_1',
      document_name: 'main.tex',
      document_format: 'tex',
      selection_hash: 'abc123',
      tool_manifest_version: 'superleaf-tools@1',
      context_changed: 'selection',
    },
    inputs: {},
    ...patch,
  }
}

describe('agentPromptPolicy', () => {
  it('keeps legacy SuperLeaf blocks by default', () => {
    const prompt = buildCodexPromptWithPolicy({
      prepared: prepared(),
      toolResults: [],
    })

    expect(prompt).toContain('[SUPERLEAF FAST MODE]')
    expect(prompt).toContain('[SUPERLEAF TOOL GUIDE]')
    expect(prompt).toContain('Please improve the selected sentence.')
  })

  it('uses a compact turn header for context lease mode', () => {
    const input = prepared({
      codex_settings: {
        prompt_mode: 'fast-edit',
        tool_mode: 'mcp-first',
        context_mode: 'lease',
      },
      superleaf_context: {
        project_id: 'project_1',
        conversation_id: 'conv_1',
        document_id: 'doc_1',
        document_name: 'main.tex',
        document_format: 'tex',
        selection_hash: 'abc123',
        tool_manifest_version: 'superleaf-tools@1',
        context_changed: 'selection',
      },
    })

    const prompt = buildCodexPromptWithPolicy({
      prepared: input,
      toolResults: [],
      contextId: 'slmcp_1',
    })

    expect(shouldUseCodexLeasePrompt(input, 'slmcp_1')).toBe(true)
    expect(prompt).toContain('[SUPERLEAF TURN]')
    expect(prompt).toContain('context_id: slmcp_1')
    expect(prompt).toContain('context_mode: lease')
    expect(prompt).toContain('selection_hash: abc123')
    expect(prompt).not.toContain('[SUPERLEAF FAST MODE]')
    expect(prompt).not.toContain('[SUPERLEAF TOOL GUIDE]')
    expect(prompt).toContain('Please improve the selected sentence.')
  })

  it('falls back to legacy blocks when direct tool transport is disabled', () => {
    const input = prepared({
      codex_settings: {
        prompt_mode: 'fast-edit',
        tool_mode: 'marker-only',
        context_mode: 'lease',
      },
    })
    const prompt = buildCodexPromptWithPolicy({
      prepared: input,
      toolResults: [],
      contextId: 'slmcp_1',
    })

    expect(shouldUseCodexLeasePrompt(input, 'slmcp_1')).toBe(false)
    expect(prompt).toContain('[SUPERLEAF FAST MODE]')
    expect(prompt).toContain('[SUPERLEAF TOOL GUIDE]')
  })

  it('keeps full-agent tool definitions in full-agent mode', () => {
    const prompt = buildCodexPromptWithPolicy({
      prepared: prepared({ prompt_mode: 'full-agent' }),
      toolResults: [],
    })

    expect(prompt).toContain('[AVAILABLE SUPERLEAF TOOLS]')
    expect(prompt).toContain('propose_doc_edit')
  })

  it('promotes never approval to on-request for direct SuperLeaf MCP modes', () => {
    expect(codexEffectiveApprovalPolicy(prepared({
      codex_settings: {
        prompt_mode: 'fast-edit',
        tool_mode: 'mcp-first',
        approval_policy: 'never',
      },
    }))).toBe('on-request')

    expect(codexEffectiveApprovalPolicy(prepared({
      codex_settings: {
        prompt_mode: 'fast-edit',
        tool_mode: 'browser-preflight',
        approval_policy: 'never',
      },
    }))).toBe('on-request')
  })

  it('defaults Codex approval to on-request for direct SuperLeaf MCP modes', () => {
    expect(codexEffectiveApprovalPolicy(prepared({
      codex_settings: {
        prompt_mode: 'fast-edit',
        tool_mode: 'mcp-first',
      },
    }))).toBe('on-request')
  })

  it('preserves never approval for marker-only mode', () => {
    expect(codexEffectiveApprovalPolicy(prepared({
      codex_settings: {
        prompt_mode: 'fast-edit',
        tool_mode: 'marker-only',
        approval_policy: 'never',
      },
    }))).toBe('never')
  })
})

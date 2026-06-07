import { describe, expect, it } from 'vitest'
import type { NanobotChatMessage, NanobotToolDefinition } from '../services/backendApi'
import { compactNanobotMessages } from '../services/nanobotBrowserClient'

const tools: NanobotToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'project_read_doc',
      description: 'Read a project document.',
      parameters: {
        type: 'object',
        properties: { doc_id: { type: 'string' } },
      },
    },
  },
]

const messages: NanobotChatMessage[] = [
  { role: 'system', content: 'Use SuperLeaf tools.' },
  { role: 'user', content: 'Read the current document.' },
]

describe('nanobotBrowserClient compactNanobotMessages', () => {
  it('does not duplicate tool definitions when native OpenAI tools are available', () => {
    const compacted = compactNanobotMessages(messages, tools, 'schema-only')
    const content = String(compacted[0]?.content ?? '')

    expect(content).toContain('[SUPERLEAF INSTRUCTIONS]')
    expect(content).toContain('[CURRENT USER MESSAGE]')
    expect(content).not.toContain('[AVAILABLE SUPERLEAF TOOLS]')
    expect(content).not.toContain('[SUPERLEAF TOOL GUIDE]')
    expect(content).not.toContain('project_read_doc')
  })

  it('includes compact guide text for marker fallback', () => {
    const compacted = compactNanobotMessages(messages, tools, 'marker-fallback')
    const content = String(compacted[0]?.content ?? '')

    expect(content).toContain('[SUPERLEAF TOOL GUIDE]')
    expect(content).toContain('project_read_doc')
    expect(content).toContain('fallback marker')
  })
})

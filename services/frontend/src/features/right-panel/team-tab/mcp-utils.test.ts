import { describe, expect, it } from 'vitest'
import type { McpPreset } from '../../../services/backendApi'
import { mcpPresetSourceUrl } from './mcp-utils'

function presetWithSource(source: Record<string, unknown>): McpPreset {
  return {
    id: 'demo',
    name: 'Demo',
    description: '',
    category: '',
    capabilities: [],
    source,
    transport: {
      type: 'remote',
      command: '',
      args: [],
    },
    env_schema: [],
    tool_policy: {},
    risk: { level: 'low' },
    verification: { status: 'unknown' },
  }
}

describe('mcpPresetSourceUrl', () => {
  it('allows only http(s) source URLs', () => {
    expect(mcpPresetSourceUrl(presetWithSource({ url: 'https://example.com/preset.json' }))).toBe(
      'https://example.com/preset.json',
    )
    expect(mcpPresetSourceUrl(presetWithSource({ url: 'http://example.com/preset.json' }))).toBe(
      'http://example.com/preset.json',
    )
    expect(mcpPresetSourceUrl(presetWithSource({ url: 'javascript:alert(1)' }))).toBe('')
    expect(mcpPresetSourceUrl(presetWithSource({ url: 'data:text/html,<script>alert(1)</script>' }))).toBe('')
    expect(mcpPresetSourceUrl(presetWithSource({ url: 'mailto:security@example.com' }))).toBe('')
  })

  it('falls back to a GitHub repository URL when source URL is absent or unsafe', () => {
    expect(mcpPresetSourceUrl(presetWithSource({ repo: 'OhMyYuwan/SuperLeaf.MCPs' }))).toBe(
      'https://github.com/OhMyYuwan/SuperLeaf.MCPs',
    )
    expect(
      mcpPresetSourceUrl(presetWithSource({ url: 'javascript:alert(1)', repo: 'OhMyYuwan/SuperLeaf.MCPs' })),
    ).toBe('https://github.com/OhMyYuwan/SuperLeaf.MCPs')
  })
})

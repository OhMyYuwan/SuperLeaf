import { describe, expect, it } from 'vitest'
import {
  shouldIncludeSuperleafToolGuide,
  toolGuideModeForTransport,
} from '../services/agentToolGuidePolicy'

describe('agentToolGuidePolicy', () => {
  it('uses schema-only mode when native tool transports are available', () => {
    expect(toolGuideModeForTransport('mcp-first')).toBe('schema-only')
    expect(toolGuideModeForTransport('browser-preflight')).toBe('schema-only')
    expect(toolGuideModeForTransport('native-tool-calls')).toBe('schema-only')
    expect(shouldIncludeSuperleafToolGuide('schema-only')).toBe(false)
  })

  it('uses marker fallback when direct tools are disabled or missing', () => {
    expect(toolGuideModeForTransport('marker-only')).toBe('marker-fallback')
    expect(toolGuideModeForTransport('native-tool-calls', false)).toBe('marker-fallback')
    expect(shouldIncludeSuperleafToolGuide('marker-fallback')).toBe(true)
  })
})

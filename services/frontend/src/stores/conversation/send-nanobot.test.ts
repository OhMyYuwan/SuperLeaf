import { describe, expect, it } from 'vitest'
import { browserNanobotTurnEndpoint } from './send-nanobot'

describe('browserNanobotTurnEndpoint', () => {
  it('prefers the Local Agent Host bridge endpoint over the raw Nanobot endpoint', () => {
    expect(browserNanobotTurnEndpoint({
      endpoint: 'http://127.0.0.1:8900',
      bridge_endpoint: 'http://127.0.0.1:8787',
    })).toBe('http://127.0.0.1:8787')
  })

  it('falls back to the prepared endpoint for legacy responses', () => {
    expect(browserNanobotTurnEndpoint({
      endpoint: 'http://127.0.0.1:8787',
    })).toBe('http://127.0.0.1:8787')
  })
})

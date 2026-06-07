import { describe, expect, it } from 'vitest'
import { buildMentionMirrorSegments, type MentionCandidate } from '../services/mentions'

const agent: MentionCandidate = {
  kind: 'agent',
  id: 'agent-1',
  name: 'Reviewer',
}

describe('MentionInput mirror segments', () => {
  it('preserves mixed English and Chinese text exactly', () => {
    const text = '中文 English abc 123，再来一行\nwith spaces'
    const segments = buildMentionMirrorSegments(text, [agent])

    expect(segments).toEqual([{ type: 'text', content: text }])
    expect(segments.map((seg) => ('raw' in seg ? seg.raw : seg.content)).join('')).toBe(text)
  })

  it('keeps mention raw text in the original stream', () => {
    const text = '请 @Reviewer check English width'
    const segments = buildMentionMirrorSegments(text, [agent])

    expect(segments.map((seg) => ('raw' in seg ? seg.raw : seg.content)).join('')).toBe(text)
    expect(segments).toContainEqual({
      type: 'mention',
      candidate: agent,
      raw: '@Reviewer',
    })
  })
})

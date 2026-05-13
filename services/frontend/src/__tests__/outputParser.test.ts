import { describe, it, expect } from 'vitest'
import { parseDifyOutputs } from '../services/outputParser'

const ctx = {
  range: { from: 100, to: 130 },
  selectionText: 'this is the selected sentence.',
}

describe('outputParser', () => {
  it('parses strict structured outputs and offsets ranges', () => {
    const r = parseDifyOutputs(
      {
        annotations: [{ from: 0, to: 4, content: 'too vague', type: 'comment', severity: 'medium' }],
        suggestions: [
          { from: 5, to: 7, original: 'is', proposed: 'becomes', reason: 'tense', confidence: 0.8 },
        ],
        risks: [{ from: 0, to: 30, risk_type: 'clarity', severity: 'low', description: 'unclear scope' }],
      },
      ctx,
    )
    expect(r.annotations).toHaveLength(1)
    expect(r.annotations[0].targetRange).toEqual({ from: 100, to: 104 })
    expect(r.suggestions[0].targetRange).toEqual({ from: 105, to: 107 })
    expect(r.risks[0].targetRange).toEqual({ from: 100, to: 130 })
  })

  it('extracts JSON from a fenced code block', () => {
    const text = '好的，结果如下：\n```json\n{"annotations":[{"from":0,"to":3,"content":"hi"}]}\n```'
    const r = parseDifyOutputs({ text }, ctx)
    expect(r.annotations).toHaveLength(1)
    expect(r.annotations[0].content).toBe('hi')
  })

  it('falls back to a single comment when output is plain text', () => {
    const r = parseDifyOutputs({ text: '这段话很模糊，建议加例子。' }, ctx)
    expect(r.annotations).toHaveLength(1)
    expect(r.annotations[0].content).toContain('模糊')
    expect(r.annotations[0].targetRange).toEqual({ from: 100, to: 130 })
    expect(r.suggestions).toHaveLength(0)
  })

  it('clamps out-of-bound ranges', () => {
    const r = parseDifyOutputs(
      { annotations: [{ from: -5, to: 9999, content: 'bad bounds' }] },
      ctx,
    )
    expect(r.annotations[0].targetRange).toEqual({ from: 100, to: 130 })
  })

  it('returns empty when there is nothing to parse', () => {
    const r = parseDifyOutputs({}, ctx)
    expect(r.annotations).toHaveLength(0)
    expect(r.suggestions).toHaveLength(0)
    expect(r.risks).toHaveLength(0)
  })

  it('reads structured payload nested under outputs', () => {
    const r = parseDifyOutputs(
      { text: 'ok', outputs: { suggestions: [{ from: 0, to: 4, proposed: 'these' }] } },
      ctx,
    )
    expect(r.suggestions).toHaveLength(1)
    expect(r.suggestions[0].proposed).toBe('these')
  })
})

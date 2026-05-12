import { describe, it, expect } from 'vitest'
import { createDocument } from '../services/documentParser'
import { extractSelection } from '../services/selectionContext'

describe('selectionContext', () => {
  const content = `\\section{Introduction}
Opening paragraph here.

\\subsection{Goals}
The goal statement sits inside a subsection.

\\section{Method}
Method description.`

  const doc = createDocument({
    id: 'd1',
    name: 'sample.tex',
    content,
    format: 'tex',
  })

  it('extracts text for a given range', () => {
    const goalPos = content.indexOf('goal statement')
    const sel = extractSelection(doc, { from: goalPos, to: goalPos + 14 })
    expect(sel.text).toBe('goal statement')
  })

  it('attaches deepest containing section to context', () => {
    const goalPos = content.indexOf('goal statement')
    const sel = extractSelection(doc, { from: goalPos, to: goalPos + 14 })
    expect(sel.context.sectionTitle).toBe('Goals')
  })

  it('lists paragraph ids covered by the range', () => {
    const start = content.indexOf('Opening')
    const end = content.indexOf('subsection.') + 11
    const sel = extractSelection(doc, { from: start, to: end })
    expect(sel.paragraphIds.length).toBeGreaterThanOrEqual(2)
  })

  it('provides before/after context of configured width', () => {
    const pos = content.indexOf('Method description')
    const sel = extractSelection(doc, { from: pos, to: pos + 18 }, { contextWindow: 50 })
    expect(sel.context.before.length).toBeLessThanOrEqual(50)
    expect(sel.context.before).toContain('\\section{Method}')
  })

  it('clamps out-of-bound ranges', () => {
    const sel = extractSelection(doc, { from: -10, to: 100_000 })
    expect(sel.from).toBe(0)
    expect(sel.to).toBe(content.length)
  })

  it('omits fullDocument unless requested', () => {
    const sel1 = extractSelection(doc, { from: 0, to: 5 })
    expect(sel1.context.fullDocument).toBeUndefined()

    const sel2 = extractSelection(doc, { from: 0, to: 5 }, { includeFullDocument: true })
    expect(sel2.context.fullDocument).toBe(content)
  })
})

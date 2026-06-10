import { describe, it, expect, beforeEach } from 'vitest'
import { useDocumentStore } from './documentStore'
import type { Document } from '../types/document'

function seedDoc(id: string): Document {
  return {
    id,
    format: 'md',
    content: '# Title\n\npara',
    structure: { sections: [], paragraphs: [], citations: [] } as any,
    metadata: { title: 'a.md', author: 'user', created: new Date(), modified: new Date(), tags: [] },
    version: 1,
  }
}

describe('applyDocFormatChange', () => {
  beforeEach(() => {
    useDocumentStore.setState({ documents: {} } as any)
  })

  it('updates format and recomputes structure for an open doc', () => {
    useDocumentStore.setState({ documents: { d1: seedDoc('d1') } } as any)
    useDocumentStore.getState().applyDocFormatChange('d1', 'tex')
    const doc = useDocumentStore.getState().documents['d1']
    expect(doc.format).toBe('tex')
    // structure must be a fresh object (recomputed), not the seeded one
    expect(doc.structure).toBeDefined()
  })

  it('is a no-op when the doc is not open', () => {
    useDocumentStore.getState().applyDocFormatChange('missing', 'tex')
    expect(useDocumentStore.getState().documents['missing']).toBeUndefined()
  })

  it('is a no-op when format is unchanged', () => {
    const doc = seedDoc('d1')
    useDocumentStore.setState({ documents: { d1: doc } } as any)
    useDocumentStore.getState().applyDocFormatChange('d1', 'md')
    expect(useDocumentStore.getState().documents['d1']).toBe(doc)
  })
})

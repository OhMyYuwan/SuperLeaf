import { describe, it, expect } from 'vitest'
import { renameTreeEntity, docFormatForName } from './filesystemStore'
import type { TreeFolder } from '../types/filesystem'

function tree(): TreeFolder {
  return {
    id: 'root', name: '', folders: [], files: [],
    docs: [{ id: 'd1', name: 'a.md', format: 'md' } as any],
  } as TreeFolder
}

describe('renameTreeEntity format sync', () => {
  it('recomputes doc tree-node format from new name', () => {
    const result = renameTreeEntity(tree(), 'doc', 'd1', 'a.tex')
    const doc = result?.docs.find((d) => d.id === 'd1')
    expect(doc?.name).toBe('a.tex')
    expect(doc?.format).toBe('tex')
  })

  it('defaults unknown text ext to txt', () => {
    const result = renameTreeEntity(tree(), 'doc', 'd1', 'a.tikz')
    expect(result?.docs.find((d) => d.id === 'd1')?.format).toBe('txt')
  })
})

describe('docFormatForName', () => {
  it('maps known extensions correctly', () => {
    expect(docFormatForName('file.tex')).toBe('tex')
    expect(docFormatForName('file.md')).toBe('md')
    expect(docFormatForName('file.txt')).toBe('txt')
  })

  it('defaults unknown extensions to txt', () => {
    expect(docFormatForName('file.tikz')).toBe('txt')
    expect(docFormatForName('Makefile')).toBe('txt')
  })
})

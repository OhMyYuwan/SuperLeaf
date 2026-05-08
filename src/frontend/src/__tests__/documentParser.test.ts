import { describe, it, expect } from 'vitest'
import { parseDocument, createDocument } from '../services/documentParser'

describe('documentParser', () => {
  describe('LaTeX parsing', () => {
    it('extracts sections and subsections', () => {
      const content = `\\section{Introduction}
This is intro.

\\subsection{Goals}
Goal text.

\\section{Method}
Method text.`
      const s = parseDocument(content, 'tex')
      expect(s.sections).toHaveLength(3)
      expect(s.sections[0].title).toBe('Introduction')
      expect(s.sections[0].level).toBe(1)
      expect(s.sections[1].title).toBe('Goals')
      expect(s.sections[1].level).toBe(2)
      expect(s.sections[2].title).toBe('Method')
    })

    it('builds parent-child hierarchy', () => {
      const content = `\\section{A}
\\subsection{A.1}
\\subsection{A.2}
\\section{B}`
      const s = parseDocument(content, 'tex')
      expect(s.sections[0].children).toContain(s.sections[1].id)
      expect(s.sections[0].children).toContain(s.sections[2].id)
      expect(s.sections[3].children).toHaveLength(0)
    })

    it('extracts citations', () => {
      const content = `See \\cite{knuth1984} and \\citep{lamport1994,knuth1984}.`
      const s = parseDocument(content, 'tex')
      expect(s.citations).toHaveLength(3)
      expect(s.citations.map((c) => c.key)).toEqual(['knuth1984', 'lamport1994', 'knuth1984'])
    })

    it('assigns paragraphs to deepest containing section', () => {
      const content = `\\section{Intro}
Top para.

\\subsection{Goals}
Nested para.`
      const s = parseDocument(content, 'tex')
      const topPara = s.paragraphs.find((p) => p.text.includes('Top para'))
      const nestedPara = s.paragraphs.find((p) => p.text.includes('Nested para'))
      expect(topPara?.parentSection).toBe(s.sections[0].id)
      expect(nestedPara?.parentSection).toBe(s.sections[1].id)
    })
  })

  describe('Markdown parsing', () => {
    it('extracts headings from # syntax', () => {
      const content = `# Intro
para 1

## Goals
para 2

# Method
para 3`
      const s = parseDocument(content, 'md')
      expect(s.sections).toHaveLength(3)
      expect(s.sections[0].title).toBe('Intro')
      expect(s.sections[0].level).toBe(0)
      expect(s.sections[1].level).toBe(1)
    })

    it('extracts footnote-style citations', () => {
      const content = `Some claim[^smith2020] with evidence.`
      const s = parseDocument(content, 'md')
      expect(s.citations).toHaveLength(1)
      expect(s.citations[0].key).toBe('smith2020')
    })
  })

  describe('plain text', () => {
    it('creates paragraphs but no sections', () => {
      const content = `First para.

Second para.

Third para.`
      const s = parseDocument(content, 'txt')
      expect(s.sections).toHaveLength(0)
      expect(s.paragraphs.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('createDocument', () => {
    it('wraps content with metadata and parsed structure', () => {
      const doc = createDocument({
        id: 'd1',
        name: 'test.tex',
        content: '\\section{X}\nhello',
        format: 'tex',
      })
      expect(doc.id).toBe('d1')
      expect(doc.metadata.title).toBe('test.tex')
      expect(doc.structure.sections).toHaveLength(1)
    })
  })
})

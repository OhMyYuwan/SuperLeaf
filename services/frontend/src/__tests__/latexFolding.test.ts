import { EditorState } from '@codemirror/state'
import { foldable } from '@codemirror/language'
import { describe, expect, it } from 'vitest'
import { findLatexFoldRange, type LatexFoldRange } from '../features/latex-editor/latex-folding'
import { latex } from '../features/latex-editor/latex-language'

describe('latex folding', () => {
  it('does not fold empty documents or plain text', () => {
    expect(foldAtLine([''], 1)).toBeNull()
    expect(foldAtLine(['hello', 'world'], 1)).toBeNull()
  })

  it('folds a single environment', () => {
    const state = stateOf(['\\begin{foo}', 'content', '\\end{foo}'])
    const fold = foldAtLine(state, 1)

    expect(fold).toEqual({
      from: state.doc.line(1).to,
      to: state.doc.line(3).from,
    })
  })

  it('folds nested environments against the matching end tag', () => {
    const state = stateOf([
      '\\begin{foo}',
      '\\begin{bar}',
      'content',
      '\\end{bar}',
      '\\end{foo}',
    ])

    expect(foldAtLine(state, 1)).toEqual({
      from: state.doc.line(1).to,
      to: state.doc.line(5).from,
    })
    expect(foldAtLine(state, 2)).toEqual({
      from: state.doc.line(2).to,
      to: state.doc.line(4).from,
    })
  })

  it('does not fold single-line or unclosed environments', () => {
    expect(foldAtLine(['\\begin{foo}content\\end{foo}'], 1)).toBeNull()
    expect(foldAtLine(['\\begin{foo}', 'content'], 1)).toBeNull()
  })

  it('folds comment regions marked with percent braces', () => {
    expect(foldAtLine(['Hello', '% {', 'this is folded', '% }', 'End'], 2)).toEqual({
      from: 9,
      to: 27,
    })
  })

  it('folds multiple and nested comment regions', () => {
    const state = stateOf([
      'Hello',
      '% {',
      'one',
      '% {',
      'two',
      '% {',
      'three',
      '% }',
      'two',
      '% }',
      'one',
      '% }',
      'End',
    ])

    expect(lineSpan(state, foldAtLine(state, 2))).toEqual({ fromLine: 2, toLine: 12 })
    expect(lineSpan(state, foldAtLine(state, 4))).toEqual({ fromLine: 4, toLine: 10 })
    expect(lineSpan(state, foldAtLine(state, 6))).toEqual({ fromLine: 6, toLine: 8 })
  })

  it('folds section hierarchies until the next same-or-higher heading', () => {
    const state = stateOf([
      'hello',
      '\\chapter{1}',
      '  a',
      '  \\section{1.1}',
      '    a',
      '    \\subsection{1.1.1}',
      '      a',
      '   \\section{1.2}',
      '     a',
      '     \\subsection{1.2.1}',
      '       a',
      '\\chapter{2}',
      '  a',
      '  \\section{2.1}',
      '    a',
      '  \\section{2.2}',
      '    a',
    ])

    const foldDescriptions = foldLines(state)
      .filter(Boolean)
      .map((fold) => lineSpan(state, fold))

    expect(foldDescriptions).toEqual([
      { fromLine: 2, toLine: 11 },
      { fromLine: 4, toLine: 7 },
      { fromLine: 6, toLine: 7 },
      { fromLine: 8, toLine: 11 },
      { fromLine: 10, toLine: 11 },
      { fromLine: 12, toLine: 17 },
      { fromLine: 14, toLine: 15 },
      { fromLine: 16, toLine: 17 },
    ])
  })

  it('does not treat commented section or environment commands as fold starts', () => {
    expect(foldAtLine(['% \\section{hidden}', 'text'], 1)).toBeNull()
    expect(foldAtLine(['% \\begin{foo}', 'text', '\\end{foo}'], 1)).toBeNull()
  })

  it('registers with CodeMirror foldable through the LaTeX extension', () => {
    const state = stateOf(['\\begin{foo}', 'content', '\\end{foo}'], true)
    const line = state.doc.line(1)

    expect(foldable(state, line.from, line.to)).toEqual({
      from: state.doc.line(1).to,
      to: state.doc.line(3).from,
    })
  })
})

function stateOf(lines: string[], withLatexExtension = false): EditorState {
  return EditorState.create({
    doc: lines.join('\n'),
    extensions: withLatexExtension ? [latex()] : [],
  })
}

function foldAtLine(lines: string[], lineNumber: number): LatexFoldRange | null
function foldAtLine(state: EditorState, lineNumber: number): LatexFoldRange | null
function foldAtLine(input: string[] | EditorState, lineNumber: number): LatexFoldRange | null {
  const state = Array.isArray(input) ? stateOf(input) : input
  const line = state.doc.line(lineNumber)
  return findLatexFoldRange(state, line.from, line.to)
}

function foldLines(state: EditorState): Array<LatexFoldRange | null> {
  const folds: Array<LatexFoldRange | null> = []
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    folds.push(foldAtLine(state, lineNumber))
  }
  return folds
}

function lineSpan(state: EditorState, fold: LatexFoldRange | null): { fromLine: number; toLine: number } {
  expect(fold).not.toBeNull()
  return {
    fromLine: state.doc.lineAt(fold!.from).number,
    toLine: state.doc.lineAt(fold!.to).number,
  }
}

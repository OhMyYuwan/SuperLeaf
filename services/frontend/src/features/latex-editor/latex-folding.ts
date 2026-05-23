import { type EditorState, type Extension } from '@codemirror/state'
import { foldService } from '@codemirror/language'

export interface LatexFoldRange {
  from: number
  to: number
}

interface SectionMatch {
  level: number
}

interface EnvToken {
  kind: 'begin' | 'end'
  name: string
  index: number
}

const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
}

const SECTION_RE =
  /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\s*\[[^\]]*\])?\s*\{/
const BEGIN_RE = /\\begin\s*\{\s*([^{}\s]+)\s*\}/
const ENV_TOKEN_RE = /\\(begin|end)\s*\{\s*([^{}\s]+)\s*\}/g
const COMMENT_OPEN_RE = /^\s*%\s*\{\s*$/
const COMMENT_CLOSE_RE = /^\s*%\s*\}\s*$/

export function latexFolding(): Extension {
  return foldService.of(findLatexFoldRange)
}

export function findLatexFoldRange(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): LatexFoldRange | null {
  const line = state.doc.lineAt(lineStart)
  const text = state.sliceDoc(line.from, lineEnd)

  return (
    findCommentFoldRange(state, line, text) ??
    findEnvironmentFoldRange(state, line, text) ??
    findSectionFoldRange(state, line, text)
  )
}

function findCommentFoldRange(
  state: EditorState,
  line: { number: number; to: number },
  text: string,
): LatexFoldRange | null {
  if (!COMMENT_OPEN_RE.test(text)) return null

  let depth = 1
  for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
    const candidate = state.doc.line(number)
    if (COMMENT_OPEN_RE.test(candidate.text)) {
      depth += 1
    } else if (COMMENT_CLOSE_RE.test(candidate.text)) {
      depth -= 1
      if (depth === 0) {
        return validRange(line.to, candidate.to - 1)
      }
    }
  }
  return null
}

function findEnvironmentFoldRange(
  state: EditorState,
  line: { number: number; to: number },
  text: string,
): LatexFoldRange | null {
  const uncommented = stripLatexComment(text)
  const begin = uncommented.match(BEGIN_RE)
  if (!begin || begin.index == null) return null

  const envName = begin[1]
  let depth = 0
  for (let number = line.number; number <= state.doc.lines; number += 1) {
    const candidate = state.doc.line(number)
    const scanFrom = number === line.number ? begin.index : 0
    const tokens = environmentTokens(stripLatexComment(candidate.text), scanFrom)
    for (const token of tokens) {
      if (token.name !== envName) continue
      if (token.kind === 'begin') {
        depth += 1
      } else {
        depth -= 1
        if (depth === 0) {
          if (number === line.number) return null
          return validRange(line.to, candidate.from + token.index)
        }
      }
    }
  }
  return null
}

function findSectionFoldRange(
  state: EditorState,
  line: { number: number; to: number },
  text: string,
): LatexFoldRange | null {
  const section = sectionMatch(stripLatexComment(text))
  if (!section) return null

  for (let number = line.number + 1; number <= state.doc.lines; number += 1) {
    const candidate = state.doc.line(number)
    const nextSection = sectionMatch(stripLatexComment(candidate.text))
    if (nextSection && nextSection.level <= section.level) {
      return validRange(line.to, state.doc.line(number - 1).to)
    }
  }
  return validRange(line.to, state.doc.length)
}

function sectionMatch(text: string): SectionMatch | null {
  const match = text.match(SECTION_RE)
  if (!match) return null
  return { level: SECTION_LEVELS[match[1]] }
}

function environmentTokens(text: string, startAt: number): EnvToken[] {
  const tokens: EnvToken[] = []
  ENV_TOKEN_RE.lastIndex = Math.max(0, startAt)
  let match: RegExpExecArray | null
  while ((match = ENV_TOKEN_RE.exec(text)) !== null) {
    tokens.push({
      kind: match[1] === 'begin' ? 'begin' : 'end',
      name: match[2],
      index: match.index,
    })
  }
  return tokens
}

function stripLatexComment(text: string): string {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '%' && !isEscaped(text, index)) {
      return text.slice(0, index)
    }
  }
  return text
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0
  for (let pos = index - 1; pos >= 0 && text[pos] === '\\'; pos -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function validRange(from: number, to: number): LatexFoldRange | null {
  return to > from ? { from, to } : null
}

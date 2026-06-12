/**
 * Math detection and macro extraction utilities.
 *
 * Detects math environments ($...$, $$...$$, \[...\], \begin{equation}...) at cursor position.
 * Extracts \newcommand/\def macros from the entire document for MathJax context.
 *
 * Uses regex + bracket matching since we don't have Lezer LaTeX AST.
 */

export interface MathRange {
  from: number
  to: number
  content: string // formula text without delimiters
  displayMode: boolean // true = display (block), false = inline
}

/**
 * Find math environment at cursor position.
 * Returns null if cursor is not inside math or is in a comment.
 */
export function findMathAtCursor(doc: string, pos: number): MathRange | null {
  // Check if cursor is in a comment line
  if (isInComment(doc, pos)) return null

  // Try inline $...$
  const inlineDollar = tryMatchInlineDollar(doc, pos)
  if (inlineDollar) return inlineDollar

  // Try display $$...$$
  const displayDollar = tryMatchDisplayDollar(doc, pos)
  if (displayDollar) return displayDollar

  // Try \[...\]
  const bracketMath = tryMatchBracketMath(doc, pos)
  if (bracketMath) return bracketMath

  // Try \(...\)
  const parenMath = tryMatchParenMath(doc, pos)
  if (parenMath) return parenMath

  // Try \begin{equation}...\end{equation} and similar environments
  const envMath = tryMatchEnvironmentMath(doc, pos)
  if (envMath) return envMath

  return null
}

/**
 * Extract all \newcommand, \renewcommand, \def, \newenvironment definitions.
 * Returns concatenated raw strings to feed to MathJax.
 */
export function extractMacroDefinitions(doc: string): string {
  const lines: string[] = []

  // Match \newcommand, \renewcommand, \def, etc.
  const commandRe = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|def|newenvironment|renewenvironment)\*?/g
  let match: RegExpExecArray | null

  while ((match = commandRe.exec(doc)) !== null) {
    const start = match.index
    const end = findDefinitionEnd(doc, commandRe.lastIndex)
    if (end > start) {
      lines.push(doc.slice(start, end))
    }
    commandRe.lastIndex = end
  }

  return lines.join('\n')
}

function isInComment(doc: string, pos: number): boolean {
  // Find the line containing pos
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  const beforeCursor = doc.slice(lineStart, pos)

  // Check if there's an unescaped % before cursor on this line
  let i = 0
  while (i < beforeCursor.length) {
    if (beforeCursor[i] === '\\') {
      i += 2 // skip escaped char
      continue
    }
    if (beforeCursor[i] === '%') {
      return true
    }
    i++
  }
  return false
}

function tryMatchInlineDollar(doc: string, pos: number): MathRange | null {
  // Scan the current line for all unescaped, non-double `$` markers and pair
  // them up. The cursor is inside a math span iff it falls between an
  // open/close pair (odd index = opening, next even index = closing).
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  let lineEnd = doc.indexOf('\n', pos)
  if (lineEnd === -1) lineEnd = doc.length

  const dollarPositions: number[] = []
  let i = lineStart
  while (i < lineEnd) {
    const ch = doc[i]
    if (ch === '\\') {
      i += 2 // skip escape (handles \$ and other escapes)
      continue
    }
    if (ch === '$') {
      // Skip $$ — display math is handled separately
      if (doc[i + 1] === '$') {
        i += 2
        continue
      }
      dollarPositions.push(i)
    }
    i++
  }

  // Pair them: [0, 1], [2, 3], ...
  for (let pairIdx = 0; pairIdx + 1 < dollarPositions.length; pairIdx += 2) {
    const open = dollarPositions[pairIdx]
    const close = dollarPositions[pairIdx + 1]
    if (pos > open && pos <= close) {
      return {
        from: open,
        to: close + 1,
        content: doc.slice(open + 1, close),
        displayMode: false,
      }
    }
  }

  return null
}

function tryMatchDisplayDollar(doc: string, pos: number): MathRange | null {
  // Find $$ before pos
  let start = -1
  for (let i = pos - 1; i >= 1; i--) {
    if (doc[i] === '$' && doc[i - 1] === '$' && (i < 2 || doc[i - 2] !== '\\')) {
      start = i - 1
      break
    }
  }
  if (start === -1) return null

  // Find closing $$
  let end = -1
  for (let i = Math.max(pos, start + 2); i < doc.length - 1; i++) {
    if (doc[i] === '$' && doc[i + 1] === '$' && doc[i - 1] !== '\\') {
      end = i
      break
    }
  }
  if (end === -1 || end <= start) return null

  return {
    from: start,
    to: end + 2,
    content: doc.slice(start + 2, end),
    displayMode: true,
  }
}

function tryMatchBracketMath(doc: string, pos: number): MathRange | null {
  // Find \[ before pos
  const start = doc.lastIndexOf('\\[', pos)
  if (start === -1) return null

  // Find closing \]
  const end = doc.indexOf('\\]', Math.max(pos, start + 2))
  if (end === -1 || end <= start) return null

  // Check pos is in range
  if (pos < start || pos > end + 2) return null

  return {
    from: start,
    to: end + 2,
    content: doc.slice(start + 2, end),
    displayMode: true,
  }
}

function tryMatchParenMath(doc: string, pos: number): MathRange | null {
  // Find \( before pos
  const start = doc.lastIndexOf('\\(', pos)
  if (start === -1) return null

  // Find closing \)
  const end = doc.indexOf('\\)', Math.max(pos, start + 2))
  if (end === -1 || end <= start) return null

  if (pos < start || pos > end + 2) return null

  return {
    from: start,
    to: end + 2,
    content: doc.slice(start + 2, end),
    displayMode: false,
  }
}

const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*',
  'multline', 'multline*', 'split', 'array', 'eqnarray', 'eqnarray*',
  'alignat', 'alignat*', 'flalign', 'flalign*',
])

function tryMatchEnvironmentMath(doc: string, pos: number): MathRange | null {
  // Find \begin{...} before pos
  const beginRe = /\\begin\{([A-Za-z*]+)\}/g
  let match: RegExpExecArray | null
  let start = -1
  let envName = ''

  // Scan backwards from pos
  beginRe.lastIndex = 0
  while ((match = beginRe.exec(doc.slice(0, pos))) !== null) {
    if (MATH_ENVS.has(match[1])) {
      start = match.index
      envName = match[1]
    }
  }

  if (start === -1) return null

  // Find matching \end{envName}
  const endPattern = `\\end{${envName}}`
  const end = doc.indexOf(endPattern, start)
  if (end === -1) return null

  const contentStart = start + `\\begin{${envName}}`.length
  const contentEnd = end

  if (pos < start || pos > end + endPattern.length) return null

  return {
    from: start,
    to: end + endPattern.length,
    content: doc.slice(contentStart, contentEnd),
    displayMode: true,
  }
}

function findDefinitionEnd(doc: string, cursor: number): number {
  // For \newcommand{\foo}[n]{...}, find end of definition
  // For \def\foo{...}, find end

  // Skip whitespace
  while (cursor < doc.length && /\s/.test(doc[cursor])) cursor++

  // \def\foo or \newcommand{\foo}
  // Read until we've consumed all arguments

  // Simple heuristic: find the first brace group after the command
  // and consume it, then if there's more braces consume them too

  let braceCount = 0
  let foundBrace = false

  while (cursor < doc.length) {
    const char = doc[cursor]

    if (char === '\\') {
      cursor += 2 // skip escape sequence
      continue
    }

    if (char === '{') {
      braceCount++
      foundBrace = true
      cursor++
      continue
    }

    if (char === '}') {
      braceCount--
      cursor++
      if (foundBrace && braceCount === 0) {
        // Check if next char is { or [ (more arguments)
        let next = cursor
        while (next < doc.length && /\s/.test(doc[next])) next++
        if (next < doc.length && (doc[next] === '{' || doc[next] === '[')) {
          cursor = next
          continue
        }
        return cursor
      }
      continue
    }

    if (char === '[' && foundBrace) {
      // Optional argument - consume it
      const closeBracket = doc.indexOf(']', cursor)
      if (closeBracket !== -1) {
        cursor = closeBracket + 1
        continue
      }
    }

    cursor++

    // Safety: don't scan forever
    if (cursor - doc.length > 1000) break
  }

  return cursor
}

/**
 * Default extension bundle for the LaTeX editor.
 *
 * Inspired by Overleaf's `source-editor/extensions/index.ts` extension pipeline,
 * but trimmed down to a self-contained, framework-agnostic set we actually use:
 *  - history, line numbers, fold gutter, indentation, search
 *  - syntax language (LaTeX / Markdown / plain text)
 *  - bracket matching and auto-close
 *  - dark theme matching the rest of the workspace shell
 */

import { EditorSelection, Prec, type Extension, type SelectionRange } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, highlightActiveLine, highlightSpecialChars } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import {
  bracketMatching,
  foldAll,
  foldGutter,
  foldKeymap,
  indentOnInput,
  toggleFold,
  unfoldAll,
} from '@codemirror/language'
import {
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { lintKeymap } from '@codemirror/lint'
import { markdown } from '@codemirror/lang-markdown'

import { latex } from './latex-language'
import type { LatexCompletionData } from './latex-completion-data'
import { overleafLikeSearch } from './search-panel'
import { overleafDark } from './theme'

export type EditorFormat = 'tex' | 'md' | 'txt'

const AUTO_COMMENT_PREFIX = '% AUTO '
const COMMENT_PREFIX = '% '
const AUTO_COMMENT_DOUBLE_PRESS_MS = 600
const OVERLEAF_FOLDING_KEYMAP = [
  { key: 'F2', run: toggleFold },
  { key: 'Alt-Shift-1', run: foldAll },
  { key: 'Alt-Shift-0', run: unfoldAll },
]

export function languageFor(
  format: EditorFormat,
  completionData?: Partial<LatexCompletionData>,
): Extension {
  switch (format) {
    case 'tex':
      return latex(completionData)
    case 'md':
      return markdown()
    case 'txt':
    default:
      return []
  }
}

export function shortcutKeymapFor(format: EditorFormat): Extension {
  if (format === 'tex') {
    let lastCommentShortcutAt = 0

    return Prec.high(
      keymap.of([
        {
          key: 'Ctrl-b',
          mac: 'Mod-b',
          preventDefault: true,
          run: toggleLatexCommand('\\textbf'),
        },
        {
          key: 'Ctrl-i',
          mac: 'Mod-i',
          preventDefault: true,
          run: toggleLatexCommand('\\textit'),
        },
        {
          key: 'Ctrl-/',
          mac: 'Mod-/',
          preventDefault: true,
          run: (view) => {
            const now = Date.now()
            const isFastRepeat = now - lastCommentShortcutAt <= AUTO_COMMENT_DOUBLE_PRESS_MS
            lastCommentShortcutAt = now

            if (isFastRepeat && hasNonEmptySelection(view)) {
              return applyLatexAutoComment(view)
            }
            return toggleLatexLineComment(view)
          },
        },
      ]),
    )
  }

  if (format === 'md') {
    return Prec.high(
      keymap.of([
        {
          key: 'Ctrl-b',
          mac: 'Mod-b',
          preventDefault: true,
          run: toggleWrap('**', '**'),
        },
        {
          key: 'Ctrl-i',
          mac: 'Mod-i',
          preventDefault: true,
          run: toggleWrap('_', '_'),
        },
      ]),
    )
  }

  return []
}

export function baseExtensions(opts?: { includeHistory?: boolean }): Extension[] {
  const includeHistory = opts?.includeHistory ?? true
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    ...(includeHistory ? [history()] : []),
    foldGutter({
      openText: '▾',
      closedText: '▸',
    }),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    overleafLikeSearch(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    keymap.of([
      indentWithTab,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...(includeHistory ? historyKeymap : []),
      ...OVERLEAF_FOLDING_KEYMAP,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
    overleafDark(),
  ]
}

function toggleLatexCommand(command: '\\textbf' | '\\textit') {
  return toggleWrap(`${command}{`, '}')
}

function toggleLatexLineComment(view: EditorView): boolean {
  if (view.state.readOnly) return false

  const ranges = touchedLineRanges(view)
  if (ranges.length === 0) return false

  const shouldUncomment = touchedNonEmptyLines(view, ranges).every((line) =>
    isLatexCommented(line.text),
  )

  const changes = ranges.flatMap((range) =>
    linesInRange(view, range).flatMap((line) => {
      const marker = commentMarkerSpan(line.text)

      if (shouldUncomment) {
        if (!marker) return []
        return [
          {
            from: line.from + marker.from,
            to: line.from + marker.to,
            insert: '',
          },
        ]
      }

      const insertAt = line.from + leadingWhitespaceLength(line.text)
      return [{ from: insertAt, insert: COMMENT_PREFIX }]
    }),
  )

  if (changes.length === 0) return false

  view.dispatch({ changes, scrollIntoView: true })
  return true
}

function applyLatexAutoComment(view: EditorView): boolean {
  if (view.state.readOnly) return false

  const ranges = touchedLineRanges(view)
  if (ranges.length === 0) return false

  const changes = ranges.flatMap((range) =>
    linesInRange(view, range).flatMap((line) => {
      const marker = commentMarkerSpan(line.text)
      const insertAt = line.from + leadingWhitespaceLength(line.text)

      if (marker?.isAuto) return []
      if (marker) {
        return [
          {
            from: line.from + marker.from,
            to: line.from + marker.to,
            insert: AUTO_COMMENT_PREFIX,
          },
        ]
      }
      return [{ from: insertAt, insert: AUTO_COMMENT_PREFIX }]
    }),
  )

  if (changes.length === 0) return false

  view.dispatch({ changes, scrollIntoView: true })
  return true
}

function toggleWrap(prefix: string, suffix: string) {
  return (view: EditorView): boolean => {
    if (view.state.readOnly) return false

    view.dispatch(
      view.state.changeByRange((range) => {
        const selected = view.state.sliceDoc(range.from, range.to)
        const wholeSelectionUnwrap = selected.startsWith(prefix) && selected.endsWith(suffix)

        if (!range.empty && wholeSelectionUnwrap) {
          const innerFrom = range.from + prefix.length
          const innerTo = range.to - suffix.length
          const inner = view.state.sliceDoc(innerFrom, innerTo)
          return {
            changes: { from: range.from, to: range.to, insert: inner },
            range: keepDirection(range, range.from, range.from + inner.length),
          }
        }

        if (!range.empty && isWrappedBy(view.state.doc, range, prefix, suffix)) {
          return {
            changes: [
              { from: range.from - prefix.length, to: range.from, insert: '' },
              { from: range.to, to: range.to + suffix.length, insert: '' },
            ],
            range: keepDirection(range, range.from - prefix.length, range.to - prefix.length),
          }
        }

        return {
          changes: { from: range.from, to: range.to, insert: `${prefix}${selected}${suffix}` },
          range: keepDirection(
            range,
            range.from + prefix.length,
            range.from + prefix.length + selected.length,
          ),
        }
      }),
      { scrollIntoView: true },
    )

    return true
  }
}

function isWrappedBy(
  doc: EditorView['state']['doc'],
  range: SelectionRange,
  prefix: string,
  suffix: string,
): boolean {
  if (range.from < prefix.length || range.to + suffix.length > doc.length) return false
  return (
    doc.sliceString(range.from - prefix.length, range.from) === prefix &&
    doc.sliceString(range.to, range.to + suffix.length) === suffix
  )
}

function keepDirection(range: SelectionRange, from: number, to: number): SelectionRange {
  return range.anchor <= range.head
    ? EditorSelection.range(from, to)
    : EditorSelection.range(to, from)
}

interface LineNumberRange {
  from: number
  to: number
}

function hasNonEmptySelection(view: EditorView): boolean {
  return view.state.selection.ranges.some((range) => !range.empty)
}

function touchedLineRanges(view: EditorView): LineNumberRange[] {
  const ranges = view.state.selection.ranges.map((selection) => {
    const from = Math.min(selection.from, selection.to)
    let to = Math.max(selection.from, selection.to)

    if (to > from) {
      const toLine = view.state.doc.lineAt(to)
      if (to === toLine.from) to -= 1
    }

    return {
      from: view.state.doc.lineAt(from).number,
      to: view.state.doc.lineAt(to).number,
    }
  })

  return mergeLineRanges(ranges)
}

function mergeLineRanges(ranges: LineNumberRange[]): LineNumberRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: LineNumberRange[] = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.from <= last.to + 1) {
      last.to = Math.max(last.to, range.to)
    } else {
      merged.push({ ...range })
    }
  }

  return merged
}

function linesInRange(view: EditorView, range: LineNumberRange) {
  const lines = []
  for (let number = range.from; number <= range.to; number += 1) {
    lines.push(view.state.doc.line(number))
  }
  return lines
}

function touchedNonEmptyLines(view: EditorView, ranges: LineNumberRange[]) {
  const lines = ranges
    .flatMap((range) => linesInRange(view, range))
    .filter((line) => line.text.trim().length > 0)

  return lines.length > 0 ? lines : ranges.flatMap((range) => linesInRange(view, range))
}

function isLatexCommented(lineText: string): boolean {
  return lineText.slice(leadingWhitespaceLength(lineText)).startsWith('%')
}

function commentMarkerSpan(lineText: string): { from: number; to: number; isAuto: boolean } | null {
  const from = leadingWhitespaceLength(lineText)
  const rest = lineText.slice(from)

  if (rest.startsWith(AUTO_COMMENT_PREFIX)) {
    return { from, to: from + AUTO_COMMENT_PREFIX.length, isAuto: true }
  }
  if (rest.startsWith(COMMENT_PREFIX)) {
    return { from, to: from + COMMENT_PREFIX.length, isAuto: false }
  }
  if (rest.startsWith('%')) {
    return { from, to: from + 1, isAuto: false }
  }
  return null
}

function leadingWhitespaceLength(text: string): number {
  return /^[ \t]*/.exec(text)?.[0].length ?? 0
}

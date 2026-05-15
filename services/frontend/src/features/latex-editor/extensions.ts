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
  foldGutter,
  foldKeymap,
  indentOnInput,
} from '@codemirror/language'
import {
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { lintKeymap } from '@codemirror/lint'
import { markdown } from '@codemirror/lang-markdown'

import { latex } from './latex-language'
import { overleafDark } from './theme'

export type EditorFormat = 'tex' | 'md' | 'txt'

export function languageFor(format: EditorFormat): Extension {
  switch (format) {
    case 'tex':
      return latex()
    case 'md':
      return markdown()
    case 'txt':
    default:
      return []
  }
}

export function shortcutKeymapFor(format: EditorFormat): Extension {
  if (format === 'tex') {
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
    foldGutter(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
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

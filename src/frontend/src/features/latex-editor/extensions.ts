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

import type { Extension } from '@codemirror/state'
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

export function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
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
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
    overleafDark(),
  ]
}

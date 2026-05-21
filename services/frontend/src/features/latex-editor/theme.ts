/**
 * Editor theme extracted and adapted from Overleaf's `overleaf_dark` theme JSON.
 *
 * Source reference: reference/overleaf/services/web/frontend/js/features/source-editor/themes/cm6/overleaf_dark.json
 *
 * We hand-translate the JSON theme into a `EditorView.theme()` object plus a
 * matching `HighlightStyle`, since we don't carry over Overleaf's runtime
 * theme loader. Re-using this file gives the LaTeX editor a familiar look.
 */

import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

const overleafDarkTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#1b222c',
      color: '#f8f8f2',
      height: '100%',
    },
    '.cm-scroller': {
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: '14px',
      lineHeight: '1.55',
      overflow: 'auto',
      height: '100%',
    },
    '.cm-scroller::-webkit-scrollbar': {
      width: '10px',
      height: '10px',
    },
    '.cm-scroller::-webkit-scrollbar-track': {
      background: 'transparent',
    },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      background: 'rgba(148, 163, 184, 0.3)',
      borderRadius: '5px',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': {
      background: 'rgba(148, 163, 184, 0.5)',
    },
    '.cm-content': {
      caretColor: '#f8f8f0',
      padding: '12px 0',
      minHeight: '100%',
    },
    '.cm-gutters': {
      backgroundColor: '#1b222c',
      color: 'rgb(144,145,148)',
      borderRight: '1px solid rgba(148, 163, 184, 0.18)',
    },
    '.cm-activeLine': {
      backgroundColor: '#44475a40',
    },
    '&.source-jump-flash .cm-activeLine': {
      backgroundColor: 'rgba(96, 165, 250, 0.28)',
      transition: 'background-color 180ms ease',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#44475a40',
    },
    '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
      outline: '1px solid #a29709',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#f8f8f0',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      {
        background: '#44475a',
      },
    '.cm-tooltip': {
      backgroundColor: '#1b222c',
      border: '1px solid rgba(148, 163, 184, 0.22)',
      color: '#e2e8f0',
      borderRadius: '8px',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#3b82f6',
      color: 'white',
    },
    '.cm-completionInfo.cm-completionInfo-above': {
      right: 'auto',
      whiteSpace: 'normal',
      lineHeight: '1.45',
      overflowWrap: 'anywhere',
      boxShadow: '0 14px 32px rgba(2, 6, 23, 0.35)',
    },
  },
  { dark: true },
)

const overleafDarkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#ff79c6' },
  { tag: t.literal, color: '#ff79c6' },
  { tag: t.string, color: '#f1fa8c' },
  { tag: t.comment, color: '#6272a4', fontStyle: 'italic' },
  { tag: t.typeName, color: '#8be9fd', fontStyle: 'italic' },
  { tag: t.attributeName, color: '#50fa7b' },
  { tag: t.attributeValue, color: '#ffb86c', fontStyle: 'italic' },
  { tag: t.tagName, color: '#ff79c6' },
  { tag: t.function(t.variableName), color: '#50fa7b' },
  { tag: t.invalid, color: '#F8F8F0', backgroundColor: '#ff79c6' },
])

export function overleafDark(): Extension {
  return [overleafDarkTheme, syntaxHighlighting(overleafDarkHighlight)]
}

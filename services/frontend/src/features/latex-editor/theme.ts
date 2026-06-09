/**
 * Editor theme presets for the LaTeX workspace.
 *
 * The light preset is the current white writing surface. The Overleaf Dark
 * preset preserves the previous CodeMirror palette so users can switch back
 * from the personal panel.
 */

import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

export type LatexEditorThemeId = 'light' | 'overleaf-dark'

interface LatexEditorThemeColors {
  background: string
  foreground: string
  gutterBackground: string
  gutterForeground: string
  gutterBorder: string
  activeLine: string
  activeLineGutter: string
  selection: string
  sourceJumpFlash: string
  cursor: string
  command: string
  comment: string
  referenceKey: string
  string: string
  typeName: string
  attributeName: string
  attributeValue: string
  functionName: string
  invalidForeground: string
  invalidBackground: string
  scrollbarThumb: string
  scrollbarThumbHover: string
  foldIcon: string
  foldIconHoverBackground: string
  foldIconHoverForeground: string
  foldPlaceholderBorder: string
  foldPlaceholderBackground: string
  foldPlaceholderForeground: string
  tooltipBackground: string
  tooltipBorder: string
  tooltipForeground: string
  tooltipShadow: string
  matchingBracket: string
  autocompleteBackground: string
  autocompleteForeground: string
}

export const DEFAULT_LATEX_EDITOR_THEME_ID: LatexEditorThemeId = 'light'

export const LATEX_EDITOR_THEME_PRESETS = {
  light: {
    id: 'light',
    label: 'Light',
    dark: false,
    colors: {
      background: '#ffffff',
      foreground: '#111827',
      gutterBackground: '#ffffff',
      gutterForeground: '#94a3b8',
      gutterBorder: '#e5e7eb',
      activeLine: 'rgba(239, 246, 255, 0.58)',
      activeLineGutter: '#eff6ff',
      selection: 'rgba(37, 99, 235, 0.34)',
      sourceJumpFlash: 'rgba(191, 219, 254, 0.54)',
      cursor: '#111827',
      command: '#2563eb',
      comment: '#22c55e',
      referenceKey: '#22c55e',
      string: '#92400e',
      typeName: '#2563eb',
      attributeName: '#22c55e',
      attributeValue: '#22c55e',
      functionName: '#2563eb',
      invalidForeground: '#111827',
      invalidBackground: 'transparent',
      scrollbarThumb: 'rgba(148, 163, 184, 0.32)',
      scrollbarThumbHover: 'rgba(100, 116, 139, 0.42)',
      foldIcon: '#94a3b8',
      foldIconHoverBackground: '#e0f2fe',
      foldIconHoverForeground: '#2563eb',
      foldPlaceholderBorder: '#cbd5e1',
      foldPlaceholderBackground: '#f8fafc',
      foldPlaceholderForeground: '#475569',
      tooltipBackground: '#ffffff',
      tooltipBorder: '#cbd5e1',
      tooltipForeground: '#111827',
      tooltipShadow: '0 14px 32px rgba(15, 23, 42, 0.14)',
      matchingBracket: '#2563eb',
      autocompleteBackground: '#2563eb',
      autocompleteForeground: '#ffffff',
    },
  },
  'overleaf-dark': {
    id: 'overleaf-dark',
    label: 'Overleaf Dark',
    dark: true,
    colors: {
      background: '#1b222c',
      foreground: '#f8f8f2',
      gutterBackground: '#1b222c',
      gutterForeground: 'rgb(144,145,148)',
      gutterBorder: 'rgba(148, 163, 184, 0.18)',
      activeLine: '#44475a40',
      activeLineGutter: '#44475a40',
      selection: '#44475a',
      sourceJumpFlash: 'rgba(96, 165, 250, 0.28)',
      cursor: '#f8f8f0',
      command: '#ff79c6',
      comment: '#6272a4',
      referenceKey: '#50fa7b',
      string: '#f1fa8c',
      typeName: '#8be9fd',
      attributeName: '#50fa7b',
      attributeValue: '#ffb86c',
      functionName: '#50fa7b',
      invalidForeground: '#f8f8f2',
      invalidBackground: 'transparent',
      scrollbarThumb: 'rgba(148, 163, 184, 0.3)',
      scrollbarThumbHover: 'rgba(148, 163, 184, 0.5)',
      foldIcon: 'rgba(203, 213, 225, 0.68)',
      foldIconHoverBackground: 'rgba(148, 163, 184, 0.16)',
      foldIconHoverForeground: '#e2e8f0',
      foldPlaceholderBorder: 'rgba(148, 163, 184, 0.32)',
      foldPlaceholderBackground: 'rgba(15, 23, 42, 0.88)',
      foldPlaceholderForeground: 'rgba(226, 232, 240, 0.86)',
      tooltipBackground: '#1b222c',
      tooltipBorder: 'rgba(148, 163, 184, 0.22)',
      tooltipForeground: '#e2e8f0',
      tooltipShadow: '0 14px 32px rgba(2, 6, 23, 0.35)',
      matchingBracket: '#a29709',
      autocompleteBackground: '#3b82f6',
      autocompleteForeground: '#ffffff',
    },
  },
} as const satisfies Record<
  LatexEditorThemeId,
  {
    id: LatexEditorThemeId
    label: string
    dark: boolean
    colors: LatexEditorThemeColors
  }
>

export const LATEX_EDITOR_COLORS = LATEX_EDITOR_THEME_PRESETS.light.colors

export function isLatexEditorThemeId(value: unknown): value is LatexEditorThemeId {
  return value === 'light' || value === 'overleaf-dark'
}

export function resolveLatexEditorThemeId(value: unknown): LatexEditorThemeId {
  return isLatexEditorThemeId(value) ? value : DEFAULT_LATEX_EDITOR_THEME_ID
}

export function latexEditorTheme(
  themeId: LatexEditorThemeId = DEFAULT_LATEX_EDITOR_THEME_ID,
): Extension {
  const preset = LATEX_EDITOR_THEME_PRESETS[themeId]
  const colors = preset.colors

  return [
    EditorView.theme(
      {
        '&': {
          backgroundColor: colors.background,
          color: colors.foreground,
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
          background: colors.scrollbarThumb,
          borderRadius: '5px',
        },
        '.cm-scroller::-webkit-scrollbar-thumb:hover': {
          background: colors.scrollbarThumbHover,
        },
        '.cm-content': {
          caretColor: colors.cursor,
          padding: '12px 0',
          minHeight: '100%',
        },
        '.cm-gutters': {
          backgroundColor: colors.gutterBackground,
          color: colors.gutterForeground,
          borderRight: `1px solid ${colors.gutterBorder}`,
        },
        '.cm-foldGutter .cm-gutterElement > span': {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '14px',
          height: '20px',
          borderRadius: '3px',
          color: colors.foldIcon,
          cursor: 'pointer',
        },
        '.cm-foldGutter .cm-gutterElement > span:hover': {
          backgroundColor: colors.foldIconHoverBackground,
          color: colors.foldIconHoverForeground,
        },
        '.cm-foldPlaceholder': {
          border: `1px solid ${colors.foldPlaceholderBorder}`,
          borderRadius: '4px',
          backgroundColor: colors.foldPlaceholderBackground,
          color: colors.foldPlaceholderForeground,
          padding: '0 5px',
          cursor: 'pointer',
        },
        '.cm-activeLine': {
          backgroundColor: colors.activeLine,
        },
        '&.source-jump-flash .cm-activeLine': {
          backgroundColor: colors.sourceJumpFlash,
          transition: 'background-color 180ms ease',
        },
        '.cm-activeLineGutter': {
          backgroundColor: colors.activeLineGutter,
        },
        '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
          outline: `1px solid ${colors.matchingBracket}`,
        },
        '.cm-cursor, .cm-dropCursor': {
          borderLeftColor: colors.cursor,
        },
        '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
          {
            backgroundColor: `${colors.selection} !important`,
          },
        '.cm-content ::selection': {
          background: `${colors.selection} !important`,
        },
        '.cm-content .ylw-latex-reference-key': {
          color: colors.referenceKey,
        },
        '.cm-tooltip': {
          backgroundColor: colors.tooltipBackground,
          border: `1px solid ${colors.tooltipBorder}`,
          color: colors.tooltipForeground,
          borderRadius: '8px',
        },
        '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
          backgroundColor: colors.autocompleteBackground,
          color: colors.autocompleteForeground,
        },
        '.cm-completionInfo.cm-completionInfo-above': {
          right: 'auto',
          whiteSpace: 'normal',
          lineHeight: '1.45',
          overflowWrap: 'anywhere',
          boxShadow: colors.tooltipShadow,
        },
      },
      { dark: preset.dark },
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: t.keyword, color: colors.command },
        { tag: t.literal, color: colors.command },
        { tag: t.string, color: colors.string },
        { tag: t.comment, color: colors.comment, fontStyle: 'italic' },
        { tag: t.typeName, color: colors.typeName },
        { tag: t.attributeName, color: colors.attributeName },
        { tag: t.attributeValue, color: colors.attributeValue },
        { tag: t.tagName, color: colors.command },
        { tag: t.function(t.variableName), color: colors.functionName },
        {
          tag: t.invalid,
          color: colors.invalidForeground,
          backgroundColor: colors.invalidBackground,
        },
      ]),
    ),
  ]
}

export function overleafDark(themeId?: LatexEditorThemeId): Extension {
  return latexEditorTheme(themeId)
}

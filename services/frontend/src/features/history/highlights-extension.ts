/**
 * CodeMirror 6 extension that draws diff highlights as `Decoration.mark` runs.
 * Mirrors Overleaf's `source-editor/extensions/highlights.ts`: a StateField
 * holds the current spec list, and a derived DecorationSet is what CM6 paints.
 *
 * Host code rebuilds the editor whenever the diff changes (we set highlights
 * via initial state, not as effects, since the modal recreates the EditorView
 * per (from, to) pair).
 */

import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import { StateField, RangeSetBuilder, type Extension } from '@codemirror/state'

import type { HighlightSpec } from './highlights-from-diff'

const insertionMark = Decoration.mark({ class: 'ylw-cm-addition' })
const deletionMark = Decoration.mark({ class: 'ylw-cm-deletion' })

export const highlightsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value) => value,
  provide: (f) => EditorView.decorations.from(f),
})

export function buildHighlightsDecorations(specs: HighlightSpec[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const sorted = [...specs].sort((a, b) =>
    a.from === b.from ? a.to - b.to : a.from - b.from,
  )
  for (const s of sorted) {
    if (s.from < 0 || s.to <= s.from) continue
    builder.add(s.from, s.to, s.kind === 'insertion' ? insertionMark : deletionMark)
  }
  return builder.finish()
}

export function highlightsExtension(specs: HighlightSpec[]): Extension {
  const initialDeco = buildHighlightsDecorations(specs)
  return [
    highlightsField.init(() => initialDeco),
  ]
}

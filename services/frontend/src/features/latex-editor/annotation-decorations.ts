/**
 * Annotation decorations — adds underline marks for annotation / suggestion /
 * risk cards into the CodeMirror editor, and lets the host code respond when
 * the user clicks one of them.
 *
 * The plugin reads its data from a StateField that the host updates via the
 * `setAnnotationsEffect`. We keep CodeMirror oblivious to Zustand; the React
 * shell pushes the slice it cares about.
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
} from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { StateEffect, StateField, RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import type { CardKind } from '../../stores/annotationStore'

export interface DecorationSpec {
  id: string
  from: number
  to: number
  kind: CardKind
  severity: 'low' | 'medium' | 'high'
  active?: boolean
}

export const setAnnotationsEffect = StateEffect.define<DecorationSpec[]>()
export const focusAnnotationEffect = StateEffect.define<string | null>()
/**
 * Briefly highlight an annotation range (reverse direction: panel hover →
 * editor). The host toggles this via LatexEditor's `panelHoverId` prop.
 * Setting a non-null id sets `flashId`; setting null clears it.
 */
export const flashAnnotationEffect = StateEffect.define<string | null>()

type AnnotationFieldValue = { specs: DecorationSpec[]; activeId: string | null; flashId: string | null }

export const annotationDecorationsField = StateField.define<AnnotationFieldValue>({
  create: () => ({ specs: [], activeId: null, flashId: null }),
  update(value, tr) {
    let next = value
    for (const e of tr.effects) {
      if (e.is(setAnnotationsEffect)) {
        next = { ...next, specs: e.value }
      }
      if (e.is(focusAnnotationEffect)) {
        next = { ...next, activeId: e.value }
      }
      if (e.is(flashAnnotationEffect)) {
        next = { ...next, flashId: e.value }
      }
    }
    return next
  },
})

function buildDecorations(value: AnnotationFieldValue): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const sorted = [...value.specs].sort((a, b) =>
    a.from === b.from ? a.to - b.to : a.from - b.from,
  )
  for (const s of sorted) {
    if (s.from < 0 || s.to <= s.from) continue
    builder.add(
      s.from,
      s.to,
      Decoration.mark({
        class: classFor(s, s.id === value.activeId, s.id === value.flashId),
        attributes: {
          'data-ann-id': s.id,
          'data-ann-kind': s.kind,
          title: titleFor(s),
        },
      }),
    )
  }
  return builder.finish()
}

function classFor(s: DecorationSpec, active: boolean, flash: boolean): string {
  const base = `ylw-ann ylw-ann-${s.kind} ylw-sev-${s.severity}`
  const parts = [base]
  if (active) parts.push('ylw-ann-active')
  if (flash) parts.push('ylw-ann-flash')
  return parts.join(' ')
}

function titleFor(s: DecorationSpec): string {
  if (s.kind === 'suggestion') return '建议（Suggestion）'
  if (s.kind === 'risk') return '风险（Risk）'
  if (s.kind === 'user-comment') return '我的批注（User comment）'
  return '批注（Annotation）'
}

const decorationView = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state.field(annotationDecorationsField))
    }
    update(update: ViewUpdate) {
      const prev = update.startState.field(annotationDecorationsField, false)
      const cur = update.state.field(annotationDecorationsField, false)
      if (update.docChanged || prev !== cur) {
        this.decorations = buildDecorations(cur ?? { specs: [], activeId: null, flashId: null })
      }
    }
  },
  { decorations: (v) => v.decorations },
)

export interface ClickHandlerOptions {
  onPick: (id: string) => void
}

function clickHandler({ onPick }: ClickHandlerOptions): Extension {
  return EditorView.domEventHandlers({
    click(event, view) {
      const target = event.target
      if (!(target instanceof HTMLElement)) return false
      const el = target.closest('[data-ann-id]') as HTMLElement | null
      if (!el) return false
      const id = el.getAttribute('data-ann-id')
      if (id) {
        onPick(id)
        // Don't preventDefault — caret should still move so the user can edit.
        void view
        return false
      }
      return false
    },
  })
}

export function annotationDecorationsExtension(options: ClickHandlerOptions): Extension {
  return [annotationDecorationsField, decorationView, clickHandler(options)]
}

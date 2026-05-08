/**
 * LatexEditor — isolated CodeMirror 6 editor component.
 *
 * Inspired by Overleaf's `CodeMirrorEditor` shell:
 *  reference/overleaf/services/web/frontend/js/features/source-editor/components/codemirror-editor.tsx
 *
 * but kept framework-light: no contexts, no Overleaf macros, no extra services.
 * The editor manages its own EditorView and reports text changes via `onChange`.
 *
 * The `format` prop determines which language extension is loaded; switching
 * formats rebuilds the editor state through a Compartment so the active
 * document text is preserved.
 *
 * `decorations` lets the host render annotation underlines that the user can
 * click to focus a panel card; `activeDecorationId` highlights the focused one.
 */

import { useEffect, useMemo, useRef } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import type { ChangeSet } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { baseExtensions, languageFor } from './extensions'
import type { EditorFormat } from './extensions'
import {
  annotationDecorationsExtension,
  focusAnnotationEffect,
  setAnnotationsEffect,
  type DecorationSpec,
} from './annotation-decorations'

export interface DocChangeInfo {
  from: number
  to: number
  insertLen: number
}

export interface LatexEditorProps {
  value: string
  format: EditorFormat
  onChange: (value: string) => void
  onSelectionChange?: (info: {
    from: number
    to: number
    text: string
  }) => void
  onDocChange?: (changes: DocChangeInfo[]) => void
  decorations?: DecorationSpec[]
  activeDecorationId?: string | null
  onDecorationClick?: (id: string) => void
  scrollTo?: { pos: number; seq: number } | null
  className?: string
}

export function LatexEditor({
  value,
  format,
  onChange,
  onSelectionChange,
  onDocChange,
  decorations,
  activeDecorationId,
  onDecorationClick,
  scrollTo,
  className,
}: LatexEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSelectionRef = useRef(onSelectionChange)
  const onDocChangeRef = useRef(onDocChange)
  const onDecorationClickRef = useRef(onDecorationClick)
  const languageCompartment = useMemo(() => new Compartment(), [])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onSelectionRef.current = onSelectionChange
  }, [onSelectionChange])

  useEffect(() => {
    onDocChangeRef.current = onDocChange
  }, [onDocChange])

  useEffect(() => {
    onDecorationClickRef.current = onDecorationClick
  }, [onDecorationClick])

  useEffect(() => {
    if (!containerRef.current) return

    const startState = EditorState.create({
      doc: value,
      extensions: [
        ...baseExtensions(),
        languageCompartment.of(languageFor(format)),
        annotationDecorationsExtension({
          onPick: (id) => onDecorationClickRef.current?.(id),
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
            if (onDocChangeRef.current) {
              const changes = extractChanges(update.changes)
              if (changes.length > 0) onDocChangeRef.current(changes)
            }
          }
          if (update.selectionSet && onSelectionRef.current) {
            const sel = update.state.selection.main
            onSelectionRef.current({
              from: sel.from,
              to: sel.to,
              text: update.state.sliceDoc(sel.from, sel.to),
            })
          }
        }),
      ],
    })

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    })

    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply external value changes without rebuilding the editor.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    })
  }, [value])

  // Swap language when `format` changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: languageCompartment.reconfigure(languageFor(format)),
    })
  }, [format, languageCompartment])

  // Push decoration specs into the editor.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: setAnnotationsEffect.of(decorations ?? []) })
  }, [decorations])

  // Highlight the active card and (optionally) scroll it into view.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: focusAnnotationEffect.of(activeDecorationId ?? null) })
    if (!activeDecorationId || !decorations) return
    const target = decorations.find((d) => d.id === activeDecorationId)
    if (!target) return
    const docLen = view.state.doc.length
    if (target.from < 0 || target.to > docLen) return
    view.dispatch({
      effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
    })
  }, [activeDecorationId, decorations])

  useEffect(() => {
    const view = viewRef.current
    if (!view || scrollTo == null) return
    const docLen = view.state.doc.length
    const pos = Math.max(0, Math.min(scrollTo.pos, docLen))
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    view.focus()
  }, [scrollTo])

  return <div ref={containerRef} className={className} />
}

function extractChanges(changeSet: ChangeSet): DocChangeInfo[] {
  const out: DocChangeInfo[] = []
  changeSet.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({ from: fromA, to: toA, insertLen: inserted.length })
  })
  return out
}

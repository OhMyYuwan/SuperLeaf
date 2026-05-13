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
import { collaborationExtensions } from './collaboration-extensions'
import {
  annotationDecorationsExtension,
  flashAnnotationEffect,
  focusAnnotationEffect,
  setAnnotationsEffect,
  type DecorationSpec,
} from './annotation-decorations'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

export interface DocChangeInfo {
  from: number
  to: number
  insertLen: number
}

export interface SelectionInfo {
  from: number
  to: number
  text: string
  // Coordinates of the selection's end (anchor on right side of last char)
  // relative to the editor root overlay. Useful for positioning floating
  // toolbars.
  coords: { x: number; y: number } | null
}

export interface LatexEditorProps {
  value: string
  format: EditorFormat
  onChange: (value: string) => void
  onSelectionChange?: (info: SelectionInfo) => void
  onDocChange?: (changes: DocChangeInfo[]) => void
  decorations?: DecorationSpec[]
  activeDecorationId?: string | null
  /** When set, the matching decoration flashes (used for panel hover preview). */
  panelHoverId?: string | null
  onDecorationClick?: (id: string) => void
  scrollTo?: { pos: number; seq: number } | null
  className?: string
  // Rendered inside the editor's positioned container, on top of the editor.
  // Used for floating UI like a selection toolbar.
  overlay?: React.ReactNode
  // Yjs collaboration props — when provided, the editor enters collaborative mode.
  yText?: Y.Text
  awareness?: Awareness
  collaborating?: boolean
}

export function LatexEditor({
  value,
  format,
  onChange,
  onSelectionChange,
  onDocChange,
  decorations,
  activeDecorationId,
  panelHoverId,
  onDecorationClick,
  scrollTo,
  className,
  overlay,
  yText,
  awareness,
  collaborating,
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

    const isCollab = !!(collaborating && yText && awareness)

    const startState = EditorState.create({
      // In collab mode, use Y.Text's current content as the initial doc.
      // y-codemirror.next only observes future changes — it does NOT push
      // existing Y.Text content into the editor on init.
      doc: isCollab ? yText!.toString() : value,
      extensions: [
        ...baseExtensions({ includeHistory: !isCollab }),
        ...(isCollab ? collaborationExtensions(yText!, awareness!) : []),
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
            const text = update.state.sliceDoc(sel.from, sel.to)
            let coords: { x: number; y: number } | null = null
            if (sel.from !== sel.to) {
              const view = update.view
              const screenCoords = view.coordsAtPos(sel.to)
              const rootRect = view.dom.parentElement?.getBoundingClientRect()
              if (screenCoords) {
                coords = {
                  x: screenCoords.right - (rootRect?.left ?? 0),
                  y: screenCoords.top - (rootRect?.top ?? 0),
                }
              }
            }
            onSelectionRef.current({
              from: sel.from,
              to: sel.to,
              text,
              coords,
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
    // Rebuild the editor when collaboration mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collaborating, yText, awareness])

  // Apply external value changes without rebuilding the editor.
  // In collaboration mode, Yjs owns the document — skip external value sync.
  useEffect(() => {
    if (collaborating) return
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    })
  }, [value, collaborating])

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

  // Flash the hovered-in-panel annotation without moving the caret or scroll.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: flashAnnotationEffect.of(panelHoverId ?? null) })
  }, [panelHoverId])

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

  return (
    <div className={`latex-editor-root ${className ?? ''}`} style={{ position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {overlay}
    </div>
  )
}

function extractChanges(changeSet: ChangeSet): DocChangeInfo[] {
  const out: DocChangeInfo[] = []
  changeSet.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({ from: fromA, to: toA, insertLen: inserted.length })
  })
  return out
}

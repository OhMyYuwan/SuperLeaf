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

import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import type { ChangeSet } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { baseExtensions, languageFor, shortcutKeymapFor } from './extensions'
import type { EditorFormat } from './extensions'
import { setLatexCompletionDataEffect } from './latex-language'
import type { LatexCitationCompletion, LatexCompletionData, LatexFilePathCompletion, LatexLabelCompletion } from './latex-completion-data'
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

export interface EditorRestoreState {
  cursor: number
  selectionRange: { from: number; to: number }
  viewport: {
    from: number
    to: number
    firstVisibleLine?: number
  }
}

export interface LatexEditorProps {
  documentId: string
  value: string
  format: EditorFormat
  onChange: (value: string) => void
  onSelectionChange?: (info: SelectionInfo) => void
  onDocChange?: (changes: DocChangeInfo[]) => void
  restoreState?: EditorRestoreState | null
  onViewStateChange?: (documentId: string, state: EditorRestoreState) => void
  decorations?: DecorationSpec[]
  activeDecorationId?: string | null
  /** When set, the matching decoration flashes (used for panel hover preview). */
  panelHoverId?: string | null
  onDecorationClick?: (id: string) => void
  scrollTo?: { pos: number; to?: number; seq: number } | null
  className?: string
  // Rendered inside the editor's positioned container, on top of the editor.
  // Used for floating UI like a selection toolbar.
  overlay?: React.ReactNode
  // Yjs collaboration props — when provided, the editor enters collaborative mode.
  yText?: Y.Text
  awareness?: Awareness
  collaborating?: boolean
  citationCompletions?: LatexCitationCompletion[]
  filePathCompletions?: LatexFilePathCompletion[]
  labelCompletions?: LatexLabelCompletion[]
}

export function LatexEditor({
  documentId,
  value,
  format,
  onChange,
  onSelectionChange,
  onDocChange,
  restoreState,
  onViewStateChange,
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
  citationCompletions,
  filePathCompletions,
  labelCompletions,
}: LatexEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const documentIdRef = useRef(documentId)
  const onChangeRef = useRef(onChange)
  const onSelectionRef = useRef(onSelectionChange)
  const onDocChangeRef = useRef(onDocChange)
  const onViewStateRef = useRef(onViewStateChange)
  const restoreStateRef = useRef(restoreState)
  const onDecorationClickRef = useRef(onDecorationClick)
  const viewStateFrameRef = useRef<number | null>(null)
  const languageCompartment = useMemo(() => new Compartment(), [])
  const shortcutsCompartment = useMemo(() => new Compartment(), [])
  const completionData = useMemo<LatexCompletionData>(
    () => ({ citations: citationCompletions ?? [], filePaths: filePathCompletions ?? [], labels: labelCompletions ?? [] }),
    [citationCompletions, filePathCompletions, labelCompletions],
  )
  const completionDataRef = useRef(completionData)
  const [sourceJumpFlash, setSourceJumpFlash] = useState(false)

  useEffect(() => {
    documentIdRef.current = documentId
  }, [documentId])

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
    onViewStateRef.current = onViewStateChange
  }, [onViewStateChange])

  useEffect(() => {
    if (restoreState) {
      restoreStateRef.current = restoreState
    } else if (!restoreStateRef.current) {
      restoreStateRef.current = null
    }
  }, [restoreState])

  useEffect(() => {
    onDecorationClickRef.current = onDecorationClick
  }, [onDecorationClick])

  const emitViewState = (view: EditorView) => {
    const state = buildEditorViewState(view)
    restoreStateRef.current = state
    onViewStateRef.current?.(documentIdRef.current, state)
  }

  const emitCachedViewState = (view: EditorView) => {
    const cached = restoreStateRef.current
    if (!cached) {
      emitViewState(view)
      return
    }
    const selection = view.state.selection.main
    const state: EditorRestoreState = {
      ...cached,
      cursor: selection.head,
      selectionRange: {
        from: selection.from,
        to: selection.to,
      },
    }
    restoreStateRef.current = state
    onViewStateRef.current?.(documentIdRef.current, state)
  }

  const scheduleViewStateEmit = (view: EditorView) => {
    if (!onViewStateRef.current || viewStateFrameRef.current != null) return
    viewStateFrameRef.current = window.requestAnimationFrame(() => {
      viewStateFrameRef.current = null
      emitViewState(view)
    })
  }

  useEffect(() => {
    if (!containerRef.current) return

    const isCollab = !!(collaborating && yText && awareness)
    const initialDoc = isCollab ? yText!.toString() : value

    const startState = EditorState.create({
      // In collab mode, use Y.Text's current content as the initial doc.
      // y-codemirror.next only observes future changes — it does NOT push
      // existing Y.Text content into the editor on init.
      doc: initialDoc,
      selection: selectionSpecFromRestore(restoreStateRef.current, initialDoc.length),
      extensions: [
        ...baseExtensions({ includeHistory: !isCollab }),
        ...(isCollab ? collaborationExtensions(yText!, awareness!) : []),
        languageCompartment.of(languageFor(format, completionData)),
        shortcutsCompartment.of(shortcutKeymapFor(format)),
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
          if (
            update.docChanged ||
            update.selectionSet ||
            update.viewportChanged ||
            update.geometryChanged
          ) {
            scheduleViewStateEmit(update.view)
          }
        }),
      ],
    })

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    })

    viewRef.current = view

    const handleScroll = () => emitViewState(view)
    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })
    const restoreFrame = window.requestAnimationFrame(() => {
      restoreEditorViewPosition(view, restoreStateRef.current)
      emitViewState(view)
    })

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll)
      window.cancelAnimationFrame(restoreFrame)
      if (viewStateFrameRef.current != null) {
        window.cancelAnimationFrame(viewStateFrameRef.current)
        viewStateFrameRef.current = null
      }
      emitCachedViewState(view)
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
      effects: [
        languageCompartment.reconfigure(languageFor(format, completionDataRef.current)),
        shortcutsCompartment.reconfigure(shortcutKeymapFor(format)),
      ],
    })
  }, [format, languageCompartment, shortcutsCompartment])

  // Push project-level completion metadata into the LaTeX language extension.
  useEffect(() => {
    completionDataRef.current = completionData
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: setLatexCompletionDataEffect.of(completionData),
    })
  }, [completionData])

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
    const to = Math.max(pos, Math.min(scrollTo.to ?? pos, docLen))
    view.dispatch({
      selection: { anchor: pos, head: to },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    view.focus()
    view.dom.classList.add('source-jump-flash')
    setSourceJumpFlash(true)
    const timer = window.setTimeout(() => {
      view.dom.classList.remove('source-jump-flash')
      setSourceJumpFlash(false)
    }, 900)
    return () => {
      view.dom.classList.remove('source-jump-flash')
      window.clearTimeout(timer)
    }
  }, [scrollTo])

  return (
    <div
      className={`latex-editor-root ${sourceJumpFlash ? 'source-jump-flash' : ''} ${className ?? ''}`}
      style={{ position: 'relative' }}
    >
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

function buildEditorViewState(view: EditorView): EditorRestoreState {
  const selection = view.state.selection.main
  return {
    cursor: selection.head,
    selectionRange: {
      from: selection.from,
      to: selection.to,
    },
    viewport: {
      from: view.viewport.from,
      to: view.viewport.to,
      firstVisibleLine: getFirstVisibleLine(view),
    },
  }
}

function restoreEditorViewPosition(view: EditorView, restoreState?: EditorRestoreState | null) {
  if (!restoreState) return
  const selection = selectionSpecFromRestore(restoreState, view.state.doc.length)
  const firstVisibleLine = restoreState.viewport?.firstVisibleLine

  if (firstVisibleLine != null) {
    const lineNo = Math.max(1, Math.min(firstVisibleLine, view.state.doc.lines))
    const line = view.state.doc.line(lineNo)
    view.dispatch({
      selection,
      effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }),
    })
    return
  }

  view.dispatch({
    selection,
    effects: EditorView.scrollIntoView(selection.head ?? selection.anchor, { y: 'center' }),
  })
}

function selectionSpecFromRestore(
  restoreState: EditorRestoreState | null | undefined,
  docLength: number,
): { anchor: number; head?: number } {
  if (!restoreState) return { anchor: 0 }
  const from = clampPosition(restoreState.selectionRange.from, docLength)
  const to = clampPosition(restoreState.selectionRange.to, docLength)
  if (from !== to) return { anchor: from, head: to }
  return { anchor: clampPosition(restoreState.cursor, docLength) }
}

function getFirstVisibleLine(view: EditorView): number | undefined {
  try {
    const { top } = view.scrollDOM.getBoundingClientRect()
    const distanceFromDocumentTop = top - view.documentTop
    const block = view.lineBlockAtHeight(distanceFromDocumentTop)
    const pos = clampPosition(block.from, view.state.doc.length)
    return view.state.doc.lineAt(pos).number
  } catch {
    return undefined
  }
}

function clampPosition(pos: number, docLength: number) {
  return Math.max(0, Math.min(pos, docLength))
}

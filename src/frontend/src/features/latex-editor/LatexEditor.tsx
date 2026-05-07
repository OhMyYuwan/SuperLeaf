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
 */

import { useEffect, useMemo, useRef } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { baseExtensions, languageFor } from './extensions'
import type { EditorFormat } from './extensions'

export interface LatexEditorProps {
  value: string
  format: EditorFormat
  onChange: (value: string) => void
  onSelectionChange?: (info: {
    from: number
    to: number
    text: string
  }) => void
  className?: string
}

export function LatexEditor({
  value,
  format,
  onChange,
  onSelectionChange,
  className,
}: LatexEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSelectionRef = useRef(onSelectionChange)
  const languageCompartment = useMemo(() => new Compartment(), [])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onSelectionRef.current = onSelectionChange
  }, [onSelectionChange])

  // Mount the editor exactly once and tear it down on unmount.
  useEffect(() => {
    if (!containerRef.current) return

    const startState = EditorState.create({
      doc: value,
      extensions: [
        ...baseExtensions(format).filter(
          (ext) => ext !== languageFor(format),
        ),
        languageCompartment.of(languageFor(format)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
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

  return <div ref={containerRef} className={className} />
}

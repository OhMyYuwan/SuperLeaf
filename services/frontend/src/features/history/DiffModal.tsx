/**
 * DiffModal — full-screen Radix Dialog showing the unified diff between a
 * document version and either another version or the current document content.
 *
 * Renders the diff via a readonly CodeMirror 6 instance so syntax highlighting
 * (LaTeX / Markdown) carries over to the diff view, mirroring Overleaf's
 * `history-v1` viewer that reuses the source-editor's syntax stack.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, ChevronUp, ChevronDown } from 'lucide-react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { baseExtensions, languageFor, type EditorFormat } from '../latex-editor/extensions'
import { useHistoryStore } from '../../stores/historyStore'
import { isDiffBinary } from '../../services/versionApi'
import {
  highlightLocations,
  projectDiffToText,
  type HighlightSpec,
} from './highlights-from-diff'
import {
  buildHighlightsDecorations,
  highlightsField,
} from './highlights-extension'

interface DiffModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  docId: string
  format: EditorFormat
  fromVersion: number
  toVersion: number | 'current'
}

export function DiffModal({
  open,
  onOpenChange,
  docId,
  format,
  fromVersion,
  toVersion,
}: DiffModalProps) {
  const loadDiff = useHistoryStore((s) => s.loadDiff)
  const diffs = useHistoryStore((s) => s.diffs)
  const diffLoading = useHistoryStore((s) => s.diffLoading)
  const diffError = useHistoryStore((s) => s.diffError)

  const comparingCurrent = toVersion === 'current'
  const a = comparingCurrent ? fromVersion : Math.min(fromVersion, toVersion)
  const b = comparingCurrent ? 'current' : Math.max(fromVersion, toVersion)
  const key = `${docId}|${a}->${b}`
  const sameVersion = !comparingCurrent && fromVersion === toVersion
  const targetLabel = comparingCurrent ? '当前版本' : `v${b}`

  useEffect(() => {
    if (!open) return
    if (sameVersion) return
    if (diffs[key]) return
    loadDiff(docId, a, b).catch(() => {})
  }, [open, sameVersion, key, diffs, loadDiff, docId, a, b])

  const payload = diffs[key]
  const loading = diffLoading[key]
  const err = diffError[key]
  const binary = payload ? isDiffBinary(payload) : false

  const projection = useMemo(() => {
    if (!payload || binary || !Array.isArray(payload)) return null
    const proj = projectDiffToText(payload)
    return { ...proj, locations: highlightLocations(proj.highlights) }
  }, [payload, binary])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="diff-overlay" />
        <Dialog.Content className="diff-dialog">
          <div className="diff-header">
            <div>
              <Dialog.Title className="diff-title">
                版本对比 · v{a} → {targetLabel}
              </Dialog.Title>
              <Dialog.Description className="diff-subtitle">
                绿色为新增，红色为删除（以 v{a} 为基准，对比 {targetLabel}）。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="关闭">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>

          <div className="diff-body">
            {sameVersion && (
              <div className="diff-empty">请选择两个不同版本进行对比。</div>
            )}
            {!sameVersion && loading && <div className="diff-empty">加载中…</div>}
            {!sameVersion && err && <div className="diff-error">{err}</div>}
            {!sameVersion && binary && (
              <div className="diff-empty">
                其中至少一个版本是二进制内容，无法以文本方式对比。
              </div>
            )}
            {!sameVersion && projection && (
              <DiffViewer
                text={projection.text}
                highlights={projection.highlights}
                locations={projection.locations}
                format={format}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

interface DiffViewerProps {
  text: string
  highlights: HighlightSpec[]
  locations: HighlightSpec[]
  format: EditorFormat
}

function DiffViewer({ text, highlights, locations, format }: DiffViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!containerRef.current) return
    const initialDeco = buildHighlightsDecorations(highlights)
    const state = EditorState.create({
      doc: text,
      extensions: [
        ...baseExtensions({ includeHistory: false }),
        languageFor(format),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        highlightsField.init(() => initialDeco),
      ],
    })
    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [text, highlights, format])

  const jumpToLocation = (idx: number) => {
    const view = viewRef.current
    if (!view) return
    if (idx < 0 || idx >= locations.length) return
    setActiveIndex(idx)
    const loc = locations[idx]
    view.dispatch({
      effects: EditorView.scrollIntoView(loc.from, { y: 'center' }),
      selection: { anchor: loc.from },
    })
  }

  if (locations.length === 0) {
    return (
      <div className="diff-viewer">
        <div className="diff-locations-empty">两个版本内容相同。</div>
        <div ref={containerRef} className="diff-cm-container" />
      </div>
    )
  }

  return (
    <div className="diff-viewer">
      <div className="diff-locations-bar">
        <button
          className="small-btn"
          onClick={() => jumpToLocation(Math.max(0, activeIndex - 1))}
          disabled={activeIndex === 0}
          title="上一处改动"
        >
          <ChevronUp size={12} /> 上一处
        </button>
        <span className="diff-locations-counter">
          第 {activeIndex + 1} / {locations.length} 处改动
        </span>
        <button
          className="small-btn"
          onClick={() =>
            jumpToLocation(Math.min(locations.length - 1, activeIndex + 1))
          }
          disabled={activeIndex >= locations.length - 1}
          title="下一处改动"
        >
          <ChevronDown size={12} /> 下一处
        </button>
      </div>
      <div ref={containerRef} className="diff-cm-container" />
    </div>
  )
}

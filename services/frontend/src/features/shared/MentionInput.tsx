/**
 * MentionInput — shared `@`-mention enabled text input.
 *
 * Used by both the annotation comment composer and the discussion tab.
 * Renders a textarea (or single-line input) and an autocomplete dropdown
 * that lists agent + workflow + file candidates, sectioned by kind.
 *
 * By default, a second "mirror" layer sits behind multiline textareas and
 * renders the same text with each mention wrapped in a colored span. Callers
 * that use normal visible textarea text can disable that mirror layer.
 */

import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  formatInsertion,
  HARD_REJECT_BYTES,
  parseMentions,
  segmentText,
  SOFT_WARN_BYTES,
  type AgentCandidate,
  type FileCandidate,
  type MentionCandidate,
  type WorkflowCandidate,
} from '../../services/mentions'
import './mention-input.css'

export interface MentionInputHandle {
  focus(): void
  blur(): void
}

interface MentionInputProps {
  value: string
  onChange: (next: string) => void
  agents: readonly AgentCandidate[]
  workflows?: readonly WorkflowCandidate[]
  files: readonly FileCandidate[]
  placeholder?: string
  disabled?: boolean
  multiline?: boolean
  rows?: number
  className?: string
  /**
   * Called when the user selects a candidate from the dropdown. The parent can
   * veto the insertion (returning false) — used to gate large files behind a
   * confirmation dialog. If undefined, insertion always proceeds.
   */
  onCandidatePicked?: (candidate: MentionCandidate) => boolean | Promise<boolean>
  /** Submit on plain Enter (multiline still allows Shift+Enter for newlines). */
  onSubmit?: () => void
  /** Where the mention candidate menu should open relative to the input. */
  menuPlacement?: 'bottom' | 'top' | 'composer-panel'
  /** Render the multiline mirror layer used for inline mention highlights. */
  renderMirrorLayer?: boolean
  /** Render multiline placeholders in the mirror layer for transparent textareas. */
  renderMirrorPlaceholder?: boolean
}

interface MentionMenuState {
  atPos: number
  query: string
}

const MAX_VISIBLE_CANDIDATES = 15
const BOUNDARY_BEFORE = /[\s([,;:。，、；：]/

export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(
  function MentionInput(props, ref) {
    const {
      value,
      onChange,
      agents,
      workflows = [],
      files,
      placeholder,
      disabled,
      multiline = true,
      rows = 4,
      className,
      onCandidatePicked,
      onSubmit,
      menuPlacement = 'bottom',
      renderMirrorLayer = true,
      renderMirrorPlaceholder = true,
    } = props

    const taRef = useRef<HTMLTextAreaElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const mirrorRef = useRef<HTMLDivElement>(null)
    const [menu, setMenu] = useState<MentionMenuState | null>(null)
    const [highlightIdx, setHighlightIdx] = useState(0)

    useImperativeHandle(ref, () => ({
      focus: () => (multiline ? taRef.current?.focus() : inputRef.current?.focus()),
      blur: () => (multiline ? taRef.current?.blur() : inputRef.current?.blur()),
    }))

    const allCandidates: MentionCandidate[] = useMemo(
      () => [...agents, ...workflows, ...files],
      [agents, workflows, files],
    )

    const filteredAgents = useMemo(() => {
      if (!menu) return [] as AgentCandidate[]
      const q = menu.query.toLowerCase()
      return agents
        .filter((a) =>
          a.name.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          (a.displayName ?? '').toLowerCase().includes(q),
        )
        .slice(0, MAX_VISIBLE_CANDIDATES)
    }, [menu, agents])

    const filteredWorkflows = useMemo(() => {
      if (!menu) return [] as WorkflowCandidate[]
      const q = menu.query.toLowerCase()
      return workflows
        .filter((w) => w.name.toLowerCase().includes(q))
        .slice(0, MAX_VISIBLE_CANDIDATES)
    }, [menu, workflows])

    const filteredFiles = useMemo(() => {
      if (!menu) return [] as FileCandidate[]
      const q = menu.query.toLowerCase()
      if (!q) return files.slice(0, MAX_VISIBLE_CANDIDATES)
      return files
        .filter(
          (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
        )
        .slice(0, MAX_VISIBLE_CANDIDATES)
    }, [menu, files])

    const flatVisible: MentionCandidate[] = useMemo(
      () => [...filteredAgents, ...filteredWorkflows, ...filteredFiles],
      [filteredAgents, filteredWorkflows, filteredFiles],
    )
    const activeHighlightIdx = flatVisible.length > 0
      ? Math.min(highlightIdx, flatVisible.length - 1)
      : 0

    const updateMention = (text: string, caret: number) => {
      let at = -1
      for (let i = caret - 1; i >= 0; i--) {
        const ch = text[i]
        if (ch === '@') {
          if (i === 0 || BOUNDARY_BEFORE.test(text[i - 1])) at = i
          break
        }
        if (/\s/.test(ch)) break
      }
      if (at === -1) {
        setMenu(null)
        return
      }
      setMenu({ atPos: at, query: text.slice(at + 1, caret) })
    }

    const handleChange = (
      e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>,
    ) => {
      const text = e.target.value
      onChange(text)
      const caret = (e.target as HTMLTextAreaElement | HTMLInputElement).selectionStart ?? text.length
      updateMention(text, caret)
    }

    const insertCandidate = (candidate: MentionCandidate) => {
      if (!menu) return
      const inserted = formatInsertion(candidate)
      const before = value.slice(0, menu.atPos)
      const after = value.slice(menu.atPos + 1 + menu.query.length)
      const newText = before + inserted + after
      onChange(newText)
      setMenu(null)
      requestAnimationFrame(() => {
        const el = (multiline ? taRef.current : inputRef.current) as
          | HTMLTextAreaElement
          | HTMLInputElement
          | null
        if (!el) return
        const caret = before.length + inserted.length
        el.setSelectionRange(caret, caret)
        el.focus()
      })
    }

    const handlePick = async (candidate: MentionCandidate) => {
      if (onCandidatePicked) {
        const ok = await onCandidatePicked(candidate)
        if (!ok) {
          setMenu(null)
          return
        }
      }
      insertCandidate(candidate)
    }

    const handleKeyDown = (
      e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
    ) => {
      if (menu && flatVisible.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setHighlightIdx((activeHighlightIdx + 1) % flatVisible.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setHighlightIdx((activeHighlightIdx - 1 + flatVisible.length) % flatVisible.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          void handlePick(flatVisible[activeHighlightIdx])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setMenu(null)
          return
        }
      }
      if (!onSubmit) return
      if (e.key === 'Enter' && multiline && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onSubmit()
        return
      }
      if (e.key === 'Enter' && !multiline && !e.shiftKey) {
        e.preventDefault()
        onSubmit()
      }
    }

    const shouldRenderMirrorLayer = multiline && renderMirrorLayer

    // Mirror layer: render a styled copy behind the textarea. In the default
    // transparent-text mode it owns both normal text and highlighted mentions.
    const highlightSegments = useMemo(() => {
      if (!shouldRenderMirrorLayer) return []
      const mentions = parseMentions(value, allCandidates)
      return segmentText(value, mentions)
    }, [value, allCandidates, shouldRenderMirrorLayer])
    const displayPlaceholder = value.length === 0 ? placeholder : undefined
    const shouldUseMirrorPlaceholder = shouldRenderMirrorLayer && renderMirrorPlaceholder
    const mirrorPlaceholderText = shouldUseMirrorPlaceholder
      ? displayPlaceholder
      : undefined
    const nativePlaceholderText = shouldUseMirrorPlaceholder ? undefined : displayPlaceholder

    const handleScroll = () => {
      if (!shouldRenderMirrorLayer || !mirrorRef.current || !taRef.current) return
      mirrorRef.current.scrollTop = taRef.current.scrollTop
      mirrorRef.current.scrollLeft = taRef.current.scrollLeft
    }

    const showMenu = menu !== null && flatVisible.length > 0

    return (
      <div className={`mention-input-root ${className ?? ''}`}>
        {multiline ? (
          <div className={`mention-input-stack ${shouldRenderMirrorLayer ? 'with-mirror' : 'without-mirror'}`}>
            {shouldRenderMirrorLayer && (
              <div
                ref={mirrorRef}
                className="mention-input-mirror"
                aria-hidden="true"
              >
                {mirrorPlaceholderText ? (
                  <span className="mention-input-placeholder">{mirrorPlaceholderText}</span>
                ) : (
                  highlightSegments.map((seg, i) => {
                    if (seg.type === 'mention') {
                      const cls =
                        seg.candidate.kind === 'file'
                          ? 'mention-tag mention-tag-file'
                          : seg.candidate.kind === 'workflow'
                            ? 'mention-tag mention-tag-workflow'
                            : 'mention-tag'
                      return (
                        <span key={i} className={cls}>
                          {seg.raw}
                        </span>
                      )
                    }
                    return <span key={i}>{seg.content}</span>
                  })
                )}
                {/* trailing newline so the mirror grows with the textarea content */}
                {'​'}
              </div>
            )}
            <textarea
              ref={taRef}
              className={`mention-input-textarea ${shouldRenderMirrorLayer ? 'transparent-caret' : ''}`}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onScroll={handleScroll}
              placeholder={nativePlaceholderText}
              disabled={disabled}
              rows={rows}
              spellCheck={false}
            />
          </div>
        ) : (
          <input
            ref={inputRef}
            className="mention-input-text"
            type="text"
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
          />
        )}
        {showMenu && (
          <div className={`mention-menu mention-menu-${menuPlacement}`}>
            {filteredAgents.length > 0 && (
              <>
                <div className="mention-menu-section-label">Agents</div>
                {filteredAgents.map((a, i) => {
                  const idx = i
                  return (
                    <div
                      key={`a-${a.id}`}
                      className={`mention-item ${idx === activeHighlightIdx ? 'active' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        void handlePick(a)
                      }}
                    >
                      <span className="mention-icon">🤖</span>
                      <span className="mention-name">{a.displayName ?? a.name}</span>
                    </div>
                  )
                })}
              </>
            )}
            {filteredWorkflows.length > 0 && (
              <>
                <div className="mention-menu-section-label">Workflows</div>
                {filteredWorkflows.map((w, i) => {
                  const idx = filteredAgents.length + i
                  return (
                    <div
                      key={`w-${w.id}`}
                      className={`mention-item mention-item-workflow ${idx === activeHighlightIdx ? 'active' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        void handlePick(w)
                      }}
                    >
                      <span className="mention-icon">🧩</span>
                      <span className="mention-name">{w.name}</span>
                      {w.description && (
                        <span className="mention-path">{w.description}</span>
                      )}
                    </div>
                  )
                })}
              </>
            )}
            {filteredFiles.length > 0 && (
              <>
                <div className="mention-menu-section-label">Files</div>
                {filteredFiles.map((f, i) => {
                  const idx = filteredAgents.length + filteredWorkflows.length + i
                  return (
                    <div
                      key={`f-${f.id}`}
                      className={`mention-item mention-item-file ${idx === activeHighlightIdx ? 'active' : ''} ${f.size_bytes >= HARD_REJECT_BYTES ? 'oversize' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        void handlePick(f)
                      }}
                    >
                      <span className="mention-icon">{fileIcon(f)}</span>
                      <span className="mention-name">{f.name}</span>
                      {f.isCurrent && <span className="mention-pin">当前</span>}
                      <span className="mention-path">{stripTail(f.path, f.name)}</span>
                      <SizeBadge size={f.size_bytes} />
                    </div>
                  )
                })}
              </>
            )}
          </div>
        )}
      </div>
    )
  },
)

function fileIcon(f: FileCandidate): string {
  if (f.format === 'doc') return '📄'
  if (f.mime?.startsWith('image/')) return '🖼'
  if (f.mime === 'application/pdf' || f.ext === 'pdf') return '📕'
  return '📎'
}

function stripTail(path: string, name: string): string {
  if (path.endsWith(name)) {
    const trimmed = path.slice(0, -name.length).replace(/\/$/, '')
    return trimmed
  }
  return path
}

function SizeBadge({ size }: { size: number }) {
  if (size < SOFT_WARN_BYTES) return null
  const mb = size / (1024 * 1024)
  return (
    <span className={`mention-size-badge ${size >= HARD_REJECT_BYTES ? 'reject' : 'warn'}`}>
      {size >= HARD_REJECT_BYTES ? '⛔' : '⚠️'} {mb >= 1 ? `${mb.toFixed(1)}MB` : `${(size / 1024).toFixed(0)}KB`}
    </span>
  )
}

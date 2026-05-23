import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import {
  Compartment,
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder as placeholderExtension,
} from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import {
  formatInsertion,
  parseMentions,
  type AgentCandidate,
  type MentionCandidate,
  type WorkflowCandidate,
} from '../../services/mentions'
import './mention-codemirror-input.css'

interface MentionCodeMirrorInputProps {
  value: string
  onChange: (next: string) => void
  agents?: readonly AgentCandidate[]
  workflows?: readonly WorkflowCandidate[]
  files: readonly MentionCandidate[]
  placeholder?: string
  disabled?: boolean
  rows?: number
  className?: string
  onCandidatePicked?: (candidate: MentionCandidate) => boolean | Promise<boolean>
}

interface MentionMenuState {
  from: number
  to: number
  query: string
  items: MentionCandidate[]
}

const setMentionCandidatesEffect = StateEffect.define<readonly MentionCandidate[]>()

const mentionCandidatesField = StateField.define<readonly MentionCandidate[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMentionCandidatesEffect)) return effect.value
    }
    return value
  },
})

const mentionDecorationsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildMentionDecorations(view)
    }
    update(update: ViewUpdate) {
      const before = update.startState.field(mentionCandidatesField, false)
      const after = update.state.field(mentionCandidatesField, false)
      if (update.docChanged || update.viewportChanged || before !== after) {
        this.decorations = buildMentionDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

export function MentionCodeMirrorInput({
  value,
  onChange,
  agents = [],
  workflows = [],
  files,
  placeholder,
  disabled = false,
  rows = 4,
  className,
  onCandidatePicked,
}: MentionCodeMirrorInputProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onCandidatePickedRef = useRef(onCandidatePicked)
  const candidatesRef = useRef<readonly MentionCandidate[]>([])
  const menuRef = useRef<MentionMenuState | null>(null)
  const activeIdxRef = useRef(0)
  const editableCompartment = useMemo(() => new Compartment(), [])
  const [menu, setMenuState] = useState<MentionMenuState | null>(null)
  const [activeIdx, setActiveIdxState] = useState(0)

  const candidates = useMemo<readonly MentionCandidate[]>(
    () => [...agents, ...workflows, ...files],
    [agents, workflows, files],
  )

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onCandidatePickedRef.current = onCandidatePicked
  }, [onCandidatePicked])

  const setMenu = (next: MentionMenuState | null) => {
    menuRef.current = next
    setMenuState(next)
    if (!next) {
      activeIdxRef.current = 0
      setActiveIdxState(0)
      return
    }
    if (activeIdxRef.current >= next.items.length) {
      activeIdxRef.current = 0
      setActiveIdxState(0)
    }
  }

  const setActiveIdx = (next: number) => {
    activeIdxRef.current = next
    setActiveIdxState(next)
  }

  useEffect(() => {
    candidatesRef.current = candidates
    const view = viewRef.current
    if (view) {
      view.dispatch({ effects: setMentionCandidatesEffect.of(candidates) })
      refreshMentionMenu(view, candidates, setMenu)
    }
  }, [candidates])

  useEffect(() => {
    if (!containerRef.current) return

    const moveActive = (delta: number): boolean => {
      const currentMenu = menuRef.current
      if (!currentMenu) return false
      setActiveIdx((activeIdxRef.current + delta + currentMenu.items.length) % currentMenu.items.length)
      return true
    }

    const pickActive = (view: EditorView): boolean => {
      const currentMenu = menuRef.current
      if (!currentMenu) return false
      void insertMentionCandidate(view, currentMenu, currentMenu.items[activeIdxRef.current], onCandidatePickedRef)
      setMenu(null)
      return true
    }

    const closeMenu = (): boolean => {
      if (!menuRef.current) return false
      setMenu(null)
      return true
    }

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        Prec.highest(
          keymap.of([
            { key: 'ArrowDown', run: () => moveActive(1) },
            { key: 'ArrowUp', run: () => moveActive(-1) },
            { key: 'Enter', run: pickActive },
            { key: 'Tab', run: pickActive },
            { key: 'Escape', run: closeMenu },
          ]),
        ),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        placeholder ? placeholderExtension(placeholder) : [],
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          spellcheck: 'false',
          'aria-label': placeholder ?? 'Mention input',
        }),
        editableCompartment.of(editableExtensions(disabled)),
        mentionCandidatesField,
        mentionDecorationsPlugin,
        EditorView.domEventHandlers({
          keyup(_event, view) {
            refreshMentionMenu(view, candidatesRef.current, setMenu)
            return false
          },
          blur() {
            window.setTimeout(() => setMenu(null), 120)
            return false
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
            window.requestAnimationFrame(() => {
              refreshMentionMenu(update.view, candidatesRef.current, setMenu)
            })
          }
          if (update.selectionSet && !update.docChanged) refreshMentionMenu(update.view, candidatesRef.current, setMenu)
        }),
      ],
    })
    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    view.dispatch({ effects: setMentionCandidatesEffect.of(candidatesRef.current) })

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // The editor is intentionally created once; later prop changes are synced
    // through effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: editableCompartment.reconfigure(editableExtensions(disabled)) })
  }, [disabled, editableCompartment])

  const style = {
    '--mention-cm-min-height': `${Math.max(rows, 1) * 24 + 16}px`,
  } as CSSProperties

  return (
    <div
      ref={containerRef}
      className={`mention-cm-root ${className ?? ''}`}
      style={style}
    >
      {menu && (
        <div className="mention-cm-menu" onMouseDown={(event) => event.preventDefault()}>
          {menu.items.map((candidate, index) => (
            <button
              key={`${candidate.kind}-${candidate.id}`}
              type="button"
              className={`mention-cm-item ${index === activeIdx ? 'active' : ''}`}
              onMouseEnter={() => setActiveIdx(index)}
              onClick={() => {
                const view = viewRef.current
                if (!view) return
                void insertMentionCandidate(view, menu, candidate, onCandidatePickedRef)
                setMenu(null)
              }}
            >
              <span className="mention-cm-item-name">@{candidate.name}</span>
              <span className="mention-cm-item-detail">{candidate.kind === 'file' ? fileDetail(candidate) : candidate.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function editableExtensions(disabled: boolean): Extension {
  return [
    EditorState.readOnly.of(disabled),
    EditorView.editable.of(!disabled),
  ]
}

function buildMentionDecorations(view: EditorView): DecorationSet {
  const candidates = view.state.field(mentionCandidatesField, false) ?? []
  const mentions = parseMentions(view.state.doc.toString(), candidates)
  const builder = new RangeSetBuilder<Decoration>()
  for (const mention of mentions) {
    if (mention.end <= mention.start) continue
    const cls = mention.candidate.kind === 'file'
      ? 'cm-mention cm-mention-file'
      : mention.candidate.kind === 'workflow'
        ? 'cm-mention cm-mention-workflow'
        : 'cm-mention'
    builder.add(
      mention.start,
      mention.end,
      Decoration.mark({
        class: cls,
        attributes: {
          title: labelFor(mention.candidate),
        },
      }),
    )
  }
  return builder.finish()
}

function mentionTokenAt(state: EditorState, pos: number): { from: number; query: string } | null {
  const line = state.doc.lineAt(pos)
  const before = state.sliceDoc(line.from, pos)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const ch = before[i]
    if (ch === '@') {
      return { from: line.from + i, query: before.slice(i + 1) }
    }
    if (/\s/.test(ch)) break
  }
  return null
}

function refreshMentionMenu(
  view: EditorView,
  candidates: readonly MentionCandidate[],
  setMenu: (next: MentionMenuState | null) => void,
) {
  const selection = view.state.selection.main
  if (!selection.empty) {
    setMenu(null)
    return
  }
  const token = mentionTokenAt(view.state, selection.head)
  if (!token) {
    setMenu(null)
    return
  }
  const query = token.query.toLowerCase()
  const items = candidates
    .filter((candidate) => {
      const label = labelFor(candidate).toLowerCase()
      const name = candidate.name.toLowerCase()
      return !query || label.includes(query) || name.includes(query)
    })
    .slice(0, 15)
  if (items.length === 0) {
    setMenu(null)
    return
  }
  setMenu({ from: token.from, to: selection.head, query: token.query, items })
}

async function insertMentionCandidate(
  view: EditorView,
  menu: MentionMenuState,
  candidate: MentionCandidate,
  onCandidatePickedRef: RefObject<((candidate: MentionCandidate) => boolean | Promise<boolean>) | undefined>,
) {
  const picked = onCandidatePickedRef.current?.(candidate)
  if (isPromise(picked)) {
    const ok = await picked
    if (ok === false) return
  } else if (picked === false) {
    return
  }
  const text = formatInsertion(candidate)
  view.dispatch({
    changes: { from: menu.from, to: menu.to, insert: text },
    selection: { anchor: menu.from + text.length },
  })
  view.focus()
}


function labelFor(candidate: MentionCandidate): string {
  return candidate.kind === 'file' ? candidate.path || candidate.name : candidate.name
}

function fileDetail(candidate: MentionCandidate): string {
  if (candidate.kind !== 'file') return candidate.kind
  return candidate.path && candidate.path !== candidate.name ? candidate.path : 'file'
}

function isPromise(value: unknown): value is Promise<boolean> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function'
}

import type { Extension, SelectionRange } from '@codemirror/state'
import { EditorSelection } from '@codemirror/state'
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search'
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view'

const MATCH_COUNT_WAIT_MS = 80
const MAX_MATCH_COUNT = 999
const MAX_MATCH_TIME_MS = 90

type MatchPosition = {
  current: number | null
  total: number
  interrupted: boolean
}

export function overleafLikeSearch(): Extension {
  return [
    search({
      top: true,
      literal: true,
      scrollToMatch,
      createPanel: (view) => new YuwanSearchPanel(view),
    }),
    EditorView.updateListener.of((update) => {
      if (!searchPanelOpen(update.startState)) return

      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (!effect.is(setSearchQuery)) continue

          const query = effect.value
          const previous = getSearchQuery(tr.startState)
          if (query.eq(previous) || !query.search) continue

          const next = selectNextMatch(query, tr.state)
          if (next) {
            const range = EditorSelection.range(next.from, next.to)
            update.view.dispatch({
              selection: range,
              effects: scrollToMatch(range, update.view),
              userEvent: 'select.search',
            })
          } else if (previous.valid) {
            update.view.dispatch({
              selection: { anchor: tr.startState.selection.main.from },
            })
          }
        }
      }
    }),
    searchPanelTheme,
  ]
}

function selectNextMatch(query: SearchQuery, state: ViewUpdate['state']) {
  if (!query.valid || !query.search) return null

  let cursor = query.getCursor(state.doc, state.selection.main.from)
  let result = cursor.next()

  if (result.done) {
    cursor = query.getCursor(state.doc)
    result = cursor.next()
  }

  return result.done ? null : result.value
}

function scrollToMatch(range: SelectionRange, view: EditorView) {
  const from = view.coordsAtPos(range.from)
  const to = view.coordsAtPos(range.to)
  const scrollRect = view.scrollDOM.getBoundingClientRect()
  const outside =
    !from ||
    !to ||
    from.top < scrollRect.top + 28 ||
    to.bottom > scrollRect.bottom - 28

  return EditorView.scrollIntoView(range, {
    y: outside ? 'center' : 'nearest',
    yMargin: 42,
  })
}

class YuwanSearchPanel implements Panel {
  readonly top = true
  readonly dom: HTMLElement

  private readonly view: EditorView
  private query: SearchQuery
  private searchField!: HTMLInputElement
  private replaceField: HTMLInputElement | null = null
  private counter!: HTMLSpanElement
  private caseButton!: HTMLButtonElement
  private regexpButton!: HTMLButtonElement
  private wordButton!: HTMLButtonElement
  private previousButton!: HTMLButtonElement
  private nextButton!: HTMLButtonElement
  private replaceToggleButton: HTMLButtonElement | null = null
  private replaceRow: HTMLDivElement | null = null
  private replaceButton: HTMLButtonElement | null = null
  private replaceAllButton: HTMLButtonElement | null = null
  private caseSensitive = false
  private regexp = false
  private wholeWord = false
  private replaceExpanded = false
  private countTimer: number | null = null

  constructor(view: EditorView) {
    this.view = view
    this.query = getSearchQuery(view.state)
    this.caseSensitive = this.query.caseSensitive
    this.regexp = this.query.regexp
    this.wholeWord = this.query.wholeWord
    this.replaceExpanded = this.query.replace.length > 0
    this.dom = this.createDom()
    this.syncFromQuery(this.query)
    this.scheduleCount(view.state)
  }

  mount() {
    this.searchField.focus()
    this.searchField.select()
    this.scheduleCount(this.view.state)
  }

  update(update: ViewUpdate) {
    let shouldCount = update.docChanged || update.selectionSet

    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery)) {
          this.syncFromQuery(effect.value)
          shouldCount = true
        }
      }
    }

    if (shouldCount) {
      this.scheduleCount(update.state)
    }
  }

  destroy() {
    if (this.countTimer != null) {
      window.clearTimeout(this.countTimer)
      this.countTimer = null
    }
  }

  private createDom() {
    const form = document.createElement('form')
    form.className = 'ylw-cm-search-panel'
    form.setAttribute('role', 'search')
    form.addEventListener('submit', (event) => event.preventDefault())
    form.addEventListener('keydown', this.handleKeyDown)

    const searchRow = document.createElement('div')
    searchRow.className = 'ylw-cm-search-row'

    const searchGroup = document.createElement('div')
    searchGroup.className = 'ylw-cm-search-input-group'

    this.searchField = document.createElement('input')
    this.searchField.className = 'ylw-cm-search-input'
    this.searchField.name = 'search'
    this.searchField.type = 'text'
    this.searchField.placeholder = '搜索当前文件'
    this.searchField.autocomplete = 'off'
    this.searchField.setAttribute('aria-label', '搜索当前文件')
    this.searchField.setAttribute('main-field', 'true')
    this.searchField.addEventListener('input', this.commit)

    this.counter = document.createElement('span')
    this.counter.className = 'ylw-cm-search-counter'
    this.counter.textContent = '0 / 0'

    searchGroup.append(this.searchField, this.counter)

    const optionGroup = document.createElement('div')
    optionGroup.className = 'ylw-cm-search-options'
    this.caseButton = this.createToggleButton('Aa', '匹配大小写', () => {
      this.caseSensitive = !this.caseSensitive
      this.commit()
      this.focusSearch()
    })
    this.regexpButton = this.createToggleButton('.*', '使用正则表达式', () => {
      this.regexp = !this.regexp
      this.commit()
      this.focusSearch()
    })
    this.wordButton = this.createToggleButton('W', '整词匹配', () => {
      this.wholeWord = !this.wholeWord
      this.commit()
      this.focusSearch()
    })
    optionGroup.append(this.caseButton, this.regexpButton, this.wordButton)
    if (!this.view.state.readOnly) {
      this.replaceToggleButton = this.createActionButton('替换', '显示替换栏', () => {
        this.setReplaceExpanded(!this.replaceExpanded)
        if (this.replaceExpanded) {
          this.replaceField?.focus()
        } else {
          this.focusSearch()
        }
      })
      this.replaceToggleButton.classList.add('ylw-cm-search-replace-toggle')
      this.replaceToggleButton.setAttribute('aria-expanded', 'false')
      optionGroup.append(this.replaceToggleButton)
    }

    const navGroup = document.createElement('div')
    navGroup.className = 'ylw-cm-search-nav'
    this.previousButton = this.createActionButton('上一个', '查找上一个匹配', () => {
      findPrevious(this.view)
      this.focusSearch()
    })
    this.nextButton = this.createActionButton('下一个', '查找下一个匹配', () => {
      findNext(this.view)
      this.focusSearch()
    })
    navGroup.append(this.previousButton, this.nextButton)

    const closeButton = this.createActionButton('×', '关闭搜索', () => {
      closeSearchPanel(this.view)
      this.view.focus()
    })
    closeButton.classList.add('ylw-cm-search-close')

    searchRow.append(searchGroup, optionGroup, navGroup, closeButton)
    form.append(searchRow)

    if (!this.view.state.readOnly) {
      const replaceRow = document.createElement('div')
      replaceRow.className = 'ylw-cm-search-row ylw-cm-search-replace-row'
      this.replaceRow = replaceRow

      const replaceGroup = document.createElement('div')
      replaceGroup.className = 'ylw-cm-search-input-group ylw-cm-search-replace-group'

      this.replaceField = document.createElement('input')
      this.replaceField.className = 'ylw-cm-search-input'
      this.replaceField.name = 'replace'
      this.replaceField.type = 'text'
      this.replaceField.placeholder = '替换为'
      this.replaceField.autocomplete = 'off'
      this.replaceField.setAttribute('aria-label', '替换为')
      this.replaceField.addEventListener('input', this.commit)
      replaceGroup.append(this.replaceField)

      const replaceActions = document.createElement('div')
      replaceActions.className = 'ylw-cm-search-replace-actions'
      this.replaceButton = this.createActionButton('替换', '替换当前匹配', () => {
        replaceNext(this.view)
        this.focusSearch()
      })
      this.replaceAllButton = this.createActionButton('全部替换', '替换所有匹配', () => {
        replaceAll(this.view)
        this.focusSearch()
      })
      replaceActions.append(this.replaceButton, this.replaceAllButton)

      replaceRow.append(replaceGroup, replaceActions)
      form.append(replaceRow)
    }

    return form
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (runScopeHandlers(this.view, event, 'search-panel')) {
      event.preventDefault()
      return
    }

    if (event.key === 'Enter' && event.target === this.searchField) {
      event.preventDefault()
      if (event.shiftKey) {
        findPrevious(this.view)
      } else {
        findNext(this.view)
      }
      return
    }

    if (event.key === 'Enter' && event.target === this.replaceField) {
      event.preventDefault()
      replaceNext(this.view)
    }
  }

  private commit = () => {
    const next = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField?.value ?? '',
      caseSensitive: this.caseSensitive,
      regexp: this.regexp,
      literal: !this.regexp,
      wholeWord: this.wholeWord,
    })

    this.query = next
    this.refreshQueryUi()
    this.view.dispatch({ effects: setSearchQuery.of(next) })
  }

  private syncFromQuery(query: SearchQuery) {
    this.query = query
    this.caseSensitive = query.caseSensitive
    this.regexp = query.regexp
    this.wholeWord = query.wholeWord

    if (this.searchField.value !== query.search) {
      this.searchField.value = query.search
    }
    if (this.replaceField && this.replaceField.value !== query.replace) {
      this.replaceField.value = query.replace
    }
    if (query.replace && !this.replaceExpanded) {
      this.setReplaceExpanded(true)
    }
    this.refreshQueryUi()
  }

  private refreshQueryUi() {
    this.dom.classList.toggle('is-invalid', this.query.regexp && !this.query.valid)
    this.setPressed(this.caseButton, this.caseSensitive)
    this.setPressed(this.regexpButton, this.regexp)
    this.setPressed(this.wordButton, this.wholeWord)
    this.setReplaceExpanded(this.replaceExpanded)

    const disabled = !this.query.valid || this.query.search.length === 0
    this.previousButton.disabled = disabled
    this.nextButton.disabled = disabled
    if (this.replaceButton) this.replaceButton.disabled = disabled
    if (this.replaceAllButton) this.replaceAllButton.disabled = disabled
  }

  private scheduleCount(state: ViewUpdate['state']) {
    if (this.countTimer != null) {
      window.clearTimeout(this.countTimer)
    }
    this.countTimer = window.setTimeout(() => {
      this.countTimer = null
      this.setPosition(countMatches(state))
    }, MATCH_COUNT_WAIT_MS)
  }

  private setPosition(position: MatchPosition | null) {
    if (this.query.regexp && !this.query.valid) {
      this.counter.textContent = '正则无效'
      this.dom.classList.remove('has-no-match')
      return
    }

    if (!position || this.query.search.length === 0) {
      this.counter.textContent = '0 / 0'
      this.dom.classList.remove('has-no-match')
      return
    }

    this.counter.textContent = `${position.current ?? 0} / ${position.total}${position.interrupted ? '+' : ''}`
    this.dom.classList.toggle('has-no-match', position.total === 0)
  }

  private createToggleButton(label: string, title: string, onClick: () => void) {
    const button = this.createActionButton(label, title, onClick)
    button.classList.add('ylw-cm-search-toggle')
    button.setAttribute('aria-pressed', 'false')
    return button
  }

  private createActionButton(label: string, title: string, onClick: () => void) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ylw-cm-search-button'
    button.textContent = label
    button.title = title
    button.setAttribute('aria-label', title)
    button.addEventListener('click', onClick)
    return button
  }

  private setPressed(button: HTMLButtonElement, pressed: boolean) {
    button.classList.toggle('is-active', pressed)
    button.setAttribute('aria-pressed', String(pressed))
  }

  private setReplaceExpanded(expanded: boolean) {
    this.replaceExpanded = expanded
    this.replaceRow?.classList.toggle('is-collapsed', !expanded)
    if (this.replaceToggleButton) {
      this.replaceToggleButton.classList.toggle('is-active', expanded)
      this.replaceToggleButton.setAttribute('aria-expanded', String(expanded))
      this.replaceToggleButton.title = expanded ? '隐藏替换栏' : '显示替换栏'
      this.replaceToggleButton.setAttribute(
        'aria-label',
        expanded ? '隐藏替换栏' : '显示替换栏',
      )
    }
  }

  private focusSearch() {
    this.searchField.focus()
  }
}

function countMatches(state: ViewUpdate['state']): MatchPosition | null {
  const query = getSearchQuery(state)
  if (!query.valid || !query.search) return null

  const cursor = query.getCursor(state.doc)
  const startTime = Date.now()
  const selection = state.selection.main
  let total = 0
  let current: number | null = null
  let result = cursor.next()

  while (!result.done) {
    total += 1
    const { from, to } = result.value

    if (current === null && selection.from === from && selection.to === to) {
      current = total
    }

    if (total >= MAX_MATCH_COUNT || Date.now() - startTime > MAX_MATCH_TIME_MS) {
      return { current, total, interrupted: true }
    }

    result = cursor.next()
  }

  return { current: current ?? (total === 0 ? null : 0), total, interrupted: false }
}

const searchPanelTheme = EditorView.theme({
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
    backgroundColor: '#111827',
  },
  '.cm-panel.ylw-cm-search-panel': {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px 10px',
    backgroundColor: '#111827',
    color: '#dbe4ef',
    boxSizing: 'border-box',
    containerType: 'inline-size',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  '.ylw-cm-search-row': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
    flexWrap: 'wrap',
  },
  '.ylw-cm-search-input-group': {
    display: 'inline-flex',
    alignItems: 'center',
    flex: '1 1 250px',
    minWidth: '160px',
    maxWidth: '100%',
    height: '30px',
    border: '1px solid rgba(148, 163, 184, 0.28)',
    borderRadius: '6px',
    backgroundColor: 'rgba(15, 23, 42, 0.96)',
    overflow: 'hidden',
  },
  '.ylw-cm-search-input': {
    flex: '1 1 auto',
    minWidth: 0,
    width: '190px',
    height: '100%',
    border: 0,
    outline: 0,
    padding: '0 9px',
    color: '#f8fafc',
    backgroundColor: 'transparent',
    font: 'inherit',
    fontSize: '12px',
  },
  '.ylw-cm-search-input::placeholder': {
    color: 'rgba(148, 163, 184, 0.72)',
  },
  '.ylw-cm-search-input-group:focus-within': {
    borderColor: 'rgba(59, 130, 246, 0.72)',
    boxShadow: '0 0 0 2px rgba(59, 130, 246, 0.18)',
  },
  '.ylw-cm-search-counter': {
    flexShrink: 0,
    minWidth: '54px',
    padding: '0 8px',
    borderLeft: '1px solid rgba(148, 163, 184, 0.18)',
    color: 'rgba(203, 213, 225, 0.82)',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
  '.ylw-cm-search-options, .ylw-cm-search-nav, .ylw-cm-search-replace-actions': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
  },
  '.ylw-cm-search-button': {
    height: '30px',
    minWidth: '30px',
    maxWidth: '140px',
    padding: '0 9px',
    border: '1px solid rgba(148, 163, 184, 0.24)',
    borderRadius: '6px',
    color: 'rgba(226, 232, 240, 0.9)',
    backgroundColor: 'rgba(15, 23, 42, 0.76)',
    font: 'inherit',
    fontSize: '12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  '.ylw-cm-search-button:hover': {
    borderColor: 'rgba(148, 163, 184, 0.46)',
    backgroundColor: 'rgba(30, 41, 59, 0.92)',
    color: '#f8fafc',
  },
  '.ylw-cm-search-button:focus-visible': {
    outline: '2px solid rgba(59, 130, 246, 0.72)',
    outlineOffset: '1px',
  },
  '.ylw-cm-search-button:disabled': {
    cursor: 'not-allowed',
    color: 'rgba(148, 163, 184, 0.42)',
    borderColor: 'rgba(148, 163, 184, 0.14)',
    backgroundColor: 'rgba(15, 23, 42, 0.42)',
  },
  '.ylw-cm-search-toggle': {
    width: '34px',
    padding: 0,
    fontWeight: 700,
  },
  '.ylw-cm-search-replace-toggle': {
    padding: '0 8px',
  },
  '.ylw-cm-search-toggle.is-active': {
    borderColor: 'rgba(96, 165, 250, 0.75)',
    color: '#bfdbfe',
    backgroundColor: 'rgba(37, 99, 235, 0.22)',
  },
  '.ylw-cm-search-close': {
    marginLeft: 'auto',
    fontSize: '18px',
    lineHeight: 1,
  },
  '.ylw-cm-search-replace-row': {
    paddingLeft: 0,
  },
  '.ylw-cm-search-replace-row.is-collapsed': {
    display: 'none',
  },
  '.ylw-cm-search-replace-group': {
    flex: '1 1 250px',
    minWidth: '160px',
  },
  '.ylw-cm-search-replace-group .ylw-cm-search-input': {
    width: '240px',
  },
  '.ylw-cm-search-panel.is-invalid .ylw-cm-search-input-group:first-child': {
    borderColor: 'rgba(248, 113, 113, 0.78)',
    boxShadow: '0 0 0 2px rgba(239, 68, 68, 0.16)',
  },
  '.ylw-cm-search-panel.is-invalid .ylw-cm-search-counter, .ylw-cm-search-panel.has-no-match .ylw-cm-search-counter':
    {
      color: '#fecaca',
    },
  '@container (max-width: 360px)': {
    '.cm-panel.ylw-cm-search-panel': {
      padding: '8px',
    },
    '.ylw-cm-search-input-group, .ylw-cm-search-replace-group': {
      flex: '1 1 100%',
    },
    '.ylw-cm-search-input, .ylw-cm-search-replace-group .ylw-cm-search-input': {
      width: '100%',
    },
    '.ylw-cm-search-close': {
      marginLeft: 0,
    },
  },
})

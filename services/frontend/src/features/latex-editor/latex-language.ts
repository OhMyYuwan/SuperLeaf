/**
 * LaTeX language support for CodeMirror 6.
 *
 * Inspired by Overleaf's source editor (`reference/overleaf/services/web/frontend/js/features/source-editor/languages/latex/`),
 * but stays self-contained: no Lezer LaTeX grammar build step, no Overleaf macros.
 *
 * Strategy: use the CodeMirror legacy stex stream parser for syntax highlighting,
 * combined with a small LaTeX-aware autocomplete and bracket configuration.
 */

import { LanguageSupport, StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import {
  autocompletion,
  CompletionContext,
  snippetCompletion,
} from '@codemirror/autocomplete'
import type { Completion, CompletionResult } from '@codemirror/autocomplete'
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import type { EditorView, Rect } from '@codemirror/view'
import {
  latexBeginEnvironmentSnippetCompletions,
  latexCommandSnippetCompletions,
  latexSnippetCommandTriggers,
} from './latex-snippets'
import {
  completionBoostFor,
  filterCitationCompletions,
  findCitationArgumentContext,
  matchesCompletionQuery,
  normalizeLatexCompletionData,
  type LatexCitationCompletion,
  type LatexCompletionData,
  type LatexFilePathCompletion,
} from './latex-completion-data'
import { latexFolding } from './latex-folding'

/** A small but useful set of LaTeX commands and environments. */
const LATEX_COMMANDS: string[] = [
  'documentclass',
  'usepackage',
  'begin',
  'end',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
  'chapter',
  'part',
  'title',
  'author',
  'date',
  'maketitle',
  'tableofcontents',
  'label',
  'ref',
  'eqref',
  'cite',
  'citep',
  'citet',
  'citeauthor',
  'citeyear',
  'parencite',
  'textcite',
  'autocite',
  'footcite',
  'supercite',
  'nocite',
  'bibliography',
  'addbibresource',
  'printbibliography',
  'bibliographystyle',
  'bibitem',
  'item',
  'textbf',
  'textit',
  'underline',
  'emph',
  'texttt',
  'textsf',
  'textsc',
  'textsuperscript',
  'textsubscript',
  'mathbb',
  'mathcal',
  'mathrm',
  'mathit',
  'mathbf',
  'frac',
  'sqrt',
  'sum',
  'int',
  'lim',
  'left',
  'right',
  'includegraphics',
  'caption',
  'centering',
  'newline',
  'newpage',
  'footnote',
  'href',
  'url',
  'input',
  'include',
  'newcommand',
  'renewcommand',
  'newenvironment',
  'def',
  'let',
]

export const setLatexCompletionDataEffect = StateEffect.define<LatexCompletionData>()

const latexCompletionDataState = StateField.define<LatexCompletionData>({
  create: () => normalizeLatexCompletionData(),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLatexCompletionDataEffect)) {
        return normalizeLatexCompletionData(effect.value)
      }
    }
    return value
  },
})

const LATEX_ENVIRONMENTS: string[] = [
  'document',
  'abstract',
  'figure',
  'table',
  'tabular',
  'itemize',
  'enumerate',
  'description',
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'matrix',
  'pmatrix',
  'bmatrix',
  'cases',
  'array',
  'verbatim',
  'quote',
  'quotation',
  'center',
  'flushleft',
  'flushright',
  'minipage',
  'theorem',
  'lemma',
  'proof',
  'corollary',
  'definition',
]

export function latexCompletionSource(context: CompletionContext): CompletionResult | null {
  const citationResult = citationCompletion(context)
  if (citationResult) return citationResult

  const filePathResult = filePathCompletion(context)
  if (filePathResult) return filePathResult

  const labelResult = labelCompletion(context)
  if (labelResult) return labelResult

  // Match a structured environment being opened: \begin{fig...
  const beginEnv = context.matchBefore(/\\begin\{[A-Za-z*]*$/)
  if (beginEnv) {
    const prefixMatch = beginEnv.text.match(/\{([A-Za-z*]*)$/)
    const prefix = prefixMatch?.[1] ?? ''
    const structuredOptions = latexBeginEnvironmentSnippetCompletions(prefix)
    const options = [
      ...structuredOptions,
      ...genericBeginEnvironmentCompletions(
        prefix,
        new Set(structuredOptions.map((option) => option.label)),
      ),
    ]
    if (options.length > 0) {
      return {
        from: beginEnv.from,
        to: context.pos,
        options,
        filter: false,
        update: (_current, _from, _to, nextContext) => latexCompletionSource(nextContext),
      }
    }
  }

  // Match a LaTeX command being typed: \word
  const command = context.matchBefore(/\\[A-Za-z]*/)
  if (command && command.from !== command.to) {
    if (
      command.text === '\\' &&
      command.from > 0 &&
      context.state.sliceDoc(command.from - 1, command.from) === '\\'
    ) {
      return null
    }
    const prefix = command.text.slice(1)
    const snippetTriggers = latexSnippetCommandTriggers()
    const snippetCompletions = latexCommandSnippetCompletions(prefix)
    const commandCompletions = LATEX_COMMANDS
      .filter((name) => matchesCommandQuery(name, prefix))
      .filter((name) => !snippetTriggers.has(name))
      .map((name): Completion => ({
        label: `\\${name}`,
        type: 'function',
        apply: `\\${name}`,
        boost: completionBoostFor(name, prefix.toLowerCase(), 45),
      }))
      .sort((a, b) =>
        (b.boost ?? 0) - (a.boost ?? 0) ||
        a.label.localeCompare(b.label),
      )
    return {
      from: command.from,
      to: context.pos,
      options: [...snippetCompletions, ...commandCompletions],
      filter: false,
      update: (_current, _from, _to, nextContext) => latexCompletionSource(nextContext),
    }
  }

  // Match an environment being closed: \end{...
  const env = context.matchBefore(/\\end\{[A-Za-z*]*$/)
  if (env) {
    const prefixMatch = env.text.match(/\{([A-Za-z*]*)$/)
    if (!prefixMatch) return null
    const start = env.from + env.text.length - prefixMatch[1].length
    return {
      from: start,
      options: LATEX_ENVIRONMENTS.map((name) => ({
        label: name,
        type: 'class',
        apply: name + '}',
      })),
      validFor: /^[A-Za-z*]*$/,
    }
  }

  return null
}

function citationCompletion(context: CompletionContext): CompletionResult | null {
  const completionData = context.state.field(latexCompletionDataState, false)
  const citations = completionData?.citations ?? []
  if (citations.length === 0) return null

  const line = context.state.doc.lineAt(context.pos)
  const beforeCursor = context.state.sliceDoc(line.from, context.pos)
  const citationContext = findCitationArgumentContext(beforeCursor)
  if (!citationContext) return null

  const options = filterCitationCompletions(
    citations,
    citationContext.query,
    citationContext.existingKeys,
  ).map(citationToCompletion)

  if (options.length === 0 && !context.explicit) return null

  return {
    from: line.from + citationContext.fromOffset,
    to: context.pos,
    options,
    filter: false,
    update: (_current, _from, _to, nextContext) => citationCompletion(nextContext),
  }
}

function citationToCompletion(citation: LatexCitationCompletion): Completion {
  return {
    label: citation.key,
    type: 'reference',
    info: citation.info,
    apply: citation.key,
    boost: 80,
  }
}

const GRAPHIC_COMMANDS = /\\includegraphics(?:\[[^\]]*])?\{([^{}]*)$/
const INCLUDE_COMMANDS = /\\(?:input|include|subfile)\{([^{}]*)$/
const BIB_COMMANDS = /\\(?:bibliography|addbibresource)\{([^{}]*)$/

function filePathCompletion(context: CompletionContext): CompletionResult | null {
  const completionData = context.state.field(latexCompletionDataState, false)
  const filePaths = completionData?.filePaths ?? []
  if (filePaths.length === 0) return null

  const line = context.state.doc.lineAt(context.pos)
  const beforeCursor = context.state.sliceDoc(line.from, context.pos)

  let match: RegExpExecArray | null
  let kind: 'graphic' | 'include' | 'bib'

  match = GRAPHIC_COMMANDS.exec(beforeCursor)
  if (match) { kind = 'graphic' }
  else {
    match = INCLUDE_COMMANDS.exec(beforeCursor)
    if (match) { kind = 'include' }
    else {
      match = BIB_COMMANDS.exec(beforeCursor)
      if (match) { kind = 'bib' }
      else { return null }
    }
  }

  const query = match[1] ?? ''
  const fromOffset = line.from + match.index + match[0].length - query.length

  const candidates = filePaths.filter((fp) => fp.kind === kind)
  const normalizedQuery = query.toLowerCase()
  const options: Completion[] = candidates
    .filter((fp) => !normalizedQuery || fp.path.toLowerCase().includes(normalizedQuery))
    .map((fp) => ({
      label: fp.path,
      type: 'file',
      boost: fp.path.toLowerCase().startsWith(normalizedQuery) ? 90 : 60,
    }))

  if (options.length === 0 && !context.explicit) return null

  return {
    from: fromOffset,
    to: context.pos,
    options,
    filter: false,
    update: (_current, _from, _to, nextContext) => filePathCompletion(nextContext),
  }
}

const REF_COMMANDS = /\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref)\{([^{}]*)$/

function labelCompletion(context: CompletionContext): CompletionResult | null {
  const completionData = context.state.field(latexCompletionDataState, false)
  const labels = completionData?.labels ?? []
  if (labels.length === 0) return null

  const line = context.state.doc.lineAt(context.pos)
  const beforeCursor = context.state.sliceDoc(line.from, context.pos)

  const match = REF_COMMANDS.exec(beforeCursor)
  if (!match) return null

  const query = match[1] ?? ''
  const fromOffset = line.from + match.index + match[0].length - query.length
  const normalizedQuery = query.toLowerCase()

  const options: Completion[] = labels
    .filter((l) => !normalizedQuery || l.key.toLowerCase().includes(normalizedQuery))
    .map((l) => ({
      label: l.key,
      type: 'reference',
      detail: l.source,
      boost: l.key.toLowerCase().startsWith(normalizedQuery) ? 90 : 60,
    }))

  if (options.length === 0 && !context.explicit) return null

  return {
    from: fromOffset,
    to: context.pos,
    options,
    filter: false,
    update: (_current, _from, _to, nextContext) => labelCompletion(nextContext),
  }
}

export function positionLatexCompletionInfo(
  _view: EditorView,
  list: Rect,
  _option: Rect,
  info: Rect,
  space: Rect,
): { style?: string; class?: string } {
  const margin = 8
  const listWidth = Math.max(220, list.right - list.left)
  const availableWidth = Math.max(220, space.right - space.left - margin * 2)
  const maxWidth = Math.min(460, availableWidth)
  const infoWidth = Math.max(220, info.right - info.left)
  const width = Math.min(maxWidth, Math.max(listWidth, Math.min(infoWidth, maxWidth)))
  const minLeft = space.left + margin - list.left
  const maxLeft = space.right - margin - list.left - width
  const left = Math.max(minLeft, Math.min(0, maxLeft))
  const maxHeight = Math.max(96, list.top - space.top - margin * 2)

  return {
    class: 'cm-completionInfo-above',
    style: [
      `left: ${Math.round(left)}px`,
      `bottom: calc(100% + ${margin}px)`,
      `width: ${Math.round(width)}px`,
      `max-width: ${Math.round(maxWidth)}px`,
      `max-height: ${Math.round(maxHeight)}px`,
      'overflow: auto',
    ].join('; '),
  }
}

function matchesCommandQuery(name: string, prefix: string): boolean {
  return matchesCompletionQuery(name, prefix)
}

function genericBeginEnvironmentCompletions(
  prefix: string,
  skippedLabels: Set<string>,
): Completion[] {
  const normalized = prefix.toLowerCase()
  return LATEX_ENVIRONMENTS
    .filter((name) => name.toLowerCase().startsWith(normalized))
    .filter((name) => !skippedLabels.has(name))
    .map((name) => snippetCompletion(genericEnvironmentSnippet(name), {
      label: name,
      detail: 'environment',
      type: 'class',
      boost: 40,
    }))
}

function genericEnvironmentSnippet(name: string): string {
  return `\\begin\\{${name}\\}\n\t\${1}\n\\end\\{${name}\\}\n\${0}`
}

/**
 * Public API: a single extension bundle that can be plugged into any CodeMirror
 * 6 EditorState as part of `extensions`.
 */
export function latex(completionData?: Partial<LatexCompletionData>): Extension {
  return [
    latexCompletionDataState.init(() => normalizeLatexCompletionData(completionData)),
    new LanguageSupport(StreamLanguage.define(stex)),
    latexFolding(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    autocompletion({
      override: [latexCompletionSource],
      activateOnTyping: true,
      positionInfo: positionLatexCompletionInfo,
    }),
  ]
}

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
import { linter, type Diagnostic } from '@codemirror/lint'
import { StateEffect, StateField, RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, EditorView, Rect, ViewUpdate } from '@codemirror/view'
import {
  latexBeginEnvironmentSnippetCompletions,
  latexCommandSnippetCompletions,
  latexSnippetCommandTriggers,
} from './latex-snippets'
import {
  collectLatexCitationKeyUsages,
  collectLatexReferenceKeyUsages,
  completionBoostFor,
  filterCitationCompletions,
  findCitationArgumentContext,
  matchesCompletionQuery,
  normalizeLatexCompletionData,
  type LatexCitationCompletion,
  type LatexCommandCompletion,
  type LatexCompletionData,
  type LatexLabelCompletion,
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
const MISSING_CITATION_MARK_CLASS = 'ylw-cm-missing-citation'
const MISSING_REFERENCE_MARK_CLASS = 'ylw-cm-missing-reference'
const REFERENCE_KEY_MARK_CLASS = 'ylw-latex-reference-key'
const REFERENCE_KEY_COMMANDS = new Set([
  'label',
  'ref',
  'eqref',
  'pageref',
  'autoref',
  'cref',
  'Cref',
  'nameref',
  'cite',
  'citep',
  'citet',
  'citealp',
  'citeauthor',
  'citeyear',
  'parencite',
  'textcite',
  'autocite',
  'footcite',
  'supercite',
  'nocite',
])

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
    const customCompletions = customCommandCompletions(context, prefix, new Set([
      ...snippetTriggers,
      ...LATEX_COMMANDS,
    ]))
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
      options: [...snippetCompletions, ...customCompletions, ...commandCompletions],
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

export function missingCitationDiagnosticsForContent(
  content: string,
  citations: LatexCitationCompletion[],
): Diagnostic[] {
  if (citations.length === 0) return []
  const knownKeys = new Set(citations.map((citation) => citation.key))
  return collectLatexCitationKeyUsages(content)
    .filter((usage) => !knownKeys.has(usage.key))
    .map((usage) => ({
      from: usage.from,
      to: usage.to,
      severity: 'warning',
      source: 'citation',
      markClass: MISSING_CITATION_MARK_CLASS,
      message: `未找到引用: "${usage.key}"`,
    }))
}

export function missingReferenceDiagnosticsForContent(
  content: string,
  labels: LatexLabelCompletion[],
): Diagnostic[] {
  if (labels.length === 0) return []
  const knownKeys = new Set(labels.map((label) => label.key))
  return collectLatexReferenceKeyUsages(content)
    .filter((usage) => !knownKeys.has(usage.key))
    .map((usage) => ({
      from: usage.from,
      to: usage.to,
      severity: 'warning',
      source: 'reference',
      markClass: MISSING_REFERENCE_MARK_CLASS,
      message: `未找到标签: "${usage.key}"`,
    }))
}

function missingCrossReferenceLinter(): Extension {
  return linter(
    (view) => {
      const completionData = view.state.field(latexCompletionDataState, false)
      const content = view.state.doc.toString()
      return [
        ...missingCitationDiagnosticsForContent(content, completionData?.citations ?? []),
        ...missingReferenceDiagnosticsForContent(content, completionData?.labels ?? []),
      ]
    },
    {
      delay: 400,
      needsRefresh: (update) =>
        update.docChanged ||
        update.startState.field(latexCompletionDataState, false) !==
          update.state.field(latexCompletionDataState, false),
    },
  )
}

export interface LatexReferenceKeyRange {
  from: number
  to: number
}

export function findLatexReferenceKeyRanges(source: string): LatexReferenceKeyRange[] {
  const ranges: LatexReferenceKeyRange[] = []
  const commandRe = /\\([A-Za-z]+)\*?(?:\s*\[[^\]]*])*\s*\{/g
  let match: RegExpExecArray | null

  while ((match = commandRe.exec(source)) !== null) {
    const commandName = match[1]
    if (!REFERENCE_KEY_COMMANDS.has(commandName)) continue

    const contentStart = commandRe.lastIndex
    const contentEnd = findLatexArgumentEnd(source, contentStart)
    if (contentEnd <= contentStart) continue

    ranges.push({ from: contentStart, to: contentEnd })
    commandRe.lastIndex = contentEnd + 1
  }

  return ranges
}

function findLatexArgumentEnd(source: string, contentStart: number): number {
  let depth = 1
  for (let index = contentStart; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char !== '}') continue
    depth -= 1
    if (depth === 0) return index
  }
  return -1
}

function buildLatexReferenceKeyDecorations(source: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const range of findLatexReferenceKeyRanges(source)) {
    builder.add(
      range.from,
      range.to,
      Decoration.mark({
        class: REFERENCE_KEY_MARK_CLASS,
      }),
    )
  }
  return builder.finish()
}

const latexReferenceKeyDecorationView = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildLatexReferenceKeyDecorations(view.state.doc.toString())
    }

    update(update: ViewUpdate) {
      if (!update.docChanged) return
      this.decorations = buildLatexReferenceKeyDecorations(update.state.doc.toString())
    }
  },
  { decorations: (view) => view.decorations },
)

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

function customCommandCompletions(
  context: CompletionContext,
  prefix: string,
  skippedNames: Set<string>,
): Completion[] {
  const completionData = context.state.field(latexCompletionDataState, false)
  const customCommands = completionData?.commands ?? []
  return customCommands
    .filter((command) => !skippedNames.has(command.name))
    .filter((command) => matchesCommandQuery(command.name, prefix))
    .map((command) => customCommandToCompletion(command, prefix))
    .sort((a, b) =>
      (b.boost ?? 0) - (a.boost ?? 0) ||
      a.label.localeCompare(b.label),
    )
}

function customCommandToCompletion(command: LatexCommandCompletion, prefix: string): Completion {
  const optionalArgCount = Math.max(0, command.optionalArgCount ?? 0)
  const requiredArgCount = Math.max(0, command.requiredArgCount ?? 0)
  const label = [
    `\\${command.name}`,
    '[]'.repeat(optionalArgCount),
    '{}'.repeat(requiredArgCount),
  ].join('')
  const snippet = buildCustomCommandSnippet(command.name, optionalArgCount, requiredArgCount)
  return snippetCompletion(snippet, {
    label,
    type: 'function',
    detail: command.source ? `自定义 · ${command.source}` : '自定义',
    boost: completionBoostFor(command.name, prefix.toLowerCase(), 90),
  })
}

function buildCustomCommandSnippet(
  name: string,
  optionalArgCount: number,
  requiredArgCount: number,
): string {
  let tab = 1
  const optionalArgs = Array.from({ length: optionalArgCount }, () => `[${'${' + tab++ + '}'}]`).join('')
  const requiredArgs = Array.from({ length: requiredArgCount }, () => `\\{${'${' + tab++ + '}'}\\}`).join('')
  return `\\${name}${optionalArgs}${requiredArgs}${'${0}'}`
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
    latexReferenceKeyDecorationView,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    missingCrossReferenceLinter(),
    autocompletion({
      override: [latexCompletionSource],
      activateOnTyping: true,
      positionInfo: positionLatexCompletionInfo,
    }),
  ]
}

export const __test__ = {
  findLatexReferenceKeyRanges,
}

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
import type { Extension } from '@codemirror/state'
import {
  latexBeginEnvironmentSnippetCompletions,
  latexCommandSnippetCompletions,
  latexSnippetCommandTriggers,
} from './latex-snippets'

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
  'bibliography',
  'bibliographystyle',
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

function latexCompletion(context: CompletionContext): CompletionResult | null {
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
        options,
        validFor: /^\\begin\{[A-Za-z*]*$/,
        filter: false,
      }
    }
  }

  // Match a LaTeX command being typed: \word
  const command = context.matchBefore(/\\[A-Za-z]*/)
  if (command && command.from !== command.to) {
    const prefix = command.text.slice(1)
    const snippetTriggers = latexSnippetCommandTriggers()
    const snippetCompletions = latexCommandSnippetCompletions(prefix)
    const commandCompletions = LATEX_COMMANDS
      .filter((name) => name.startsWith(prefix.toLowerCase()))
      .filter((name) => !snippetTriggers.has(name))
      .map((name) => ({
        label: `\\${name}`,
        type: 'function',
        apply: `\\${name}`,
      }))
    return {
      from: command.from,
      options: [...snippetCompletions, ...commandCompletions],
      validFor: /^\\[A-Za-z]*$/,
      filter: false,
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
export function latex(): Extension {
  return [
    new LanguageSupport(StreamLanguage.define(stex)),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    autocompletion({
      override: [latexCompletion],
      activateOnTyping: true,
    }),
  ]
}

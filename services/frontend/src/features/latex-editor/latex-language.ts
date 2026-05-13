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
} from '@codemirror/autocomplete'
import type { CompletionResult } from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'

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
  // Match a LaTeX command being typed: \word
  const command = context.matchBefore(/\\[A-Za-z]*/)
  if (command && command.from !== command.to) {
    return {
      from: command.from + 1,
      options: LATEX_COMMANDS.map((name) => ({
        label: name,
        type: 'function',
        apply: name,
      })),
      validFor: /^[A-Za-z]*$/,
    }
  }

  // Match an environment being opened: \begin{...
  const env = context.matchBefore(/\\(begin|end)\{[A-Za-z*]*$/)
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

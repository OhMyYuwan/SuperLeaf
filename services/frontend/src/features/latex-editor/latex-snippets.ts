import { snippetCompletion, type Completion } from '@codemirror/autocomplete'
import { completionBoostFor, matchesCompletionQuery } from './latex-completion-data'

export interface LatexStructuredSnippet {
  id: string
  label: string
  commandTriggers: string[]
  beginTrigger?: string
  detail: string
  template: string
  boost?: number
}

// 维护快捷指令时改这里：
// - 新增快捷指令：在 LATEX_STRUCTURED_SNIPPETS 追加一项，commandTriggers 决定输入 \xxx 时匹配哪些触发词。
// - 调整快速填充内容：修改 template；`${1:默认文本}` 会预填文字，`${1}` 是空的第一个可编辑位置。
// - 控制光标位置：CodeMirror 展开后先选中编号最小的占位符；`${0}` 是最终跳转点，若希望光标留在空括号里就不要在末尾放 `${0}`。
export const LATEX_STRUCTURED_SNIPPETS: LatexStructuredSnippet[] = [
  {
    id: 'figure',
    label: 'figure',
    commandTriggers: ['fig', 'figure'],
    beginTrigger: 'figure',
    detail: 'figure environment',
    boost: 95,
    template: [
      '\\begin\\{figure\\}[htbp]',
      '\t\\centering',
      '\t\\includegraphics[width=${1:0.8\\linewidth}]\\{${2:assets/figure.png}\\}',
      '\t\\caption\\{${3:Caption}\\}',
      '\t\\label\\{fig:${4:label}\\}',
      '\\end\\{figure\\}',
      '${0}',
    ].join('\n'),
  },
  {
    id: 'table',
    label: 'table',
    commandTriggers: ['tab', 'table'],
    beginTrigger: 'table',
    detail: 'table environment',
    boost: 94,
    template: [
      '\\begin\\{table\\}[htbp]',
      '\t\\centering',
      '\t\\caption\\{${1:Caption}\\}',
      '\t\\label\\{tab:${2:label}\\}',
      '\t\\begin\\{tabular\\}\\{${3:ll}\\}',
      '\t\t\\hline',
      '\t\t${4:Column A} & ${5:Column B} \\\\',
      '\t\t\\hline',
      '\t\t${6:Value A} & ${7:Value B} \\\\',
      '\t\t\\hline',
      '\t\\end\\{tabular\\}',
      '\\end\\{table\\}',
      '${0}',
    ].join('\n'),
  },
  {
    id: 'tabular',
    label: 'tabular',
    commandTriggers: ['tabular'],
    beginTrigger: 'tabular',
    detail: 'tabular environment',
    boost: 82,
    template: [
      '\\begin\\{tabular\\}\\{${1:ll}\\}',
      '\t\\hline',
      '\t${2:Column A} & ${3:Column B} \\\\',
      '\t\\hline',
      '\t${4:Value A} & ${5:Value B} \\\\',
      '\t\\hline',
      '\\end\\{tabular\\}',
      '${0}',
    ].join('\n'),
  },
  {
    id: 'equation',
    label: 'equation',
    commandTriggers: ['eq', 'equation'],
    beginTrigger: 'equation',
    detail: 'numbered equation',
    boost: 90,
    template: [
      '\\begin\\{equation\\}',
      '\t${1:E = mc^2}',
      '\t\\label\\{eq:${2:label}\\}',
      '\\end\\{equation\\}',
      '${0}',
    ].join('\n'),
  },
  {
    id: 'align',
    label: 'align',
    commandTriggers: ['align'],
    beginTrigger: 'align',
    detail: 'aligned equations',
    boost: 88,
    template: [
      '\\begin\\{align\\}',
      '\t${1:a} &= ${2:b} \\\\',
      '\t${3:c} &= ${4:d}',
      '\\end\\{align\\}',
      '${0}',
    ].join('\n'),
  },
  {
    id: 'itemize',
    label: 'itemize',
    commandTriggers: ['itemize', 'items'],
    beginTrigger: 'itemize',
    detail: 'bulleted list',
    boost: 84,
    template: [
      '\\begin\\{itemize\\}',
      '\t\\item ${1:First item}',
      '\t\\item ${2:Second item}',
      '\\end\\{itemize\\}',
      '${0}',
    ].join('\n'),
  },
  {
    id: 'enumerate',
    label: 'enumerate',
    commandTriggers: ['enum', 'enumerate'],
    beginTrigger: 'enumerate',
    detail: 'numbered list',
    boost: 83,
    template: [
      '\\begin\\{enumerate\\}',
      '\t\\item ${1:First item}',
      '\t\\item ${2:Second item}',
      '\\end\\{enumerate\\}',
      '${0}',
    ].join('\n'),
  },
  {
    id: 'abstract',
    label: 'abstract',
    commandTriggers: ['abstract'],
    beginTrigger: 'abstract',
    detail: 'abstract environment',
    boost: 78,
    template: [
      '\\begin\\{abstract\\}',
      '\t${1:Write a concise summary of the work.}',
      '\\end\\{abstract\\}',
      '${0}',
    ].join('\n'),
  },
  {
    id: 'section',
    label: 'section',
    commandTriggers: ['sec', 'section'],
    detail: 'section heading',
    boost: 80,
    template: '\\section\\{${1:Section Title}\\}\n${0}',
  },
  {
    id: 'subsection',
    label: 'subsection',
    commandTriggers: ['subsec', 'subsection'],
    detail: 'subsection heading',
    boost: 79,
    template: '\\subsection\\{${1:Subsection Title}\\}\n${0}',
  },
  {
    id: 'includegraphics',
    label: 'includegraphics',
    commandTriggers: ['img', 'image', 'includegraphics'],
    detail: 'include image',
    boost: 86,
    template: '\\includegraphics[width=${1:0.8\\linewidth}]\\{${2:assets/figure.png}\\}${0}',
  },
  {
    id: 'noindent',
    label: 'noindent',
    commandTriggers: ['noindent'],
    detail: 'suppress paragraph indentation',
    boost: 75,
    template: '\\noindent ${0}',
  },
  {
    id: 'indent',
    label: 'indent',
    commandTriggers: ['indent'],
    detail: 'force paragraph indentation',
    boost: 74,
    template: '\\indent ${0}',
  },
  {
    id: 'newpage',
    label: 'newpage',
    commandTriggers: ['newpage'],
    detail: 'page break',
    boost: 74,
    template: '\\newpage ${0}',
  },
  {
    id: 'clearpage',
    label: 'clearpage',
    commandTriggers: ['clearpage'],
    detail: 'page break and flush floats',
    boost: 74,
    template: '\\clearpage ${0}',
  },
  {
    id: 'smallskip',
    label: 'smallskip',
    commandTriggers: ['smallskip'],
    detail: 'small vertical space',
    boost: 73,
    template: '\\smallskip ${0}',
  },
  {
    id: 'medskip',
    label: 'medskip',
    commandTriggers: ['medskip'],
    detail: 'medium vertical space',
    boost: 73,
    template: '\\medskip ${0}',
  },
  {
    id: 'bigskip',
    label: 'bigskip',
    commandTriggers: ['bigskip'],
    detail: 'large vertical space',
    boost: 73,
    template: '\\bigskip ${0}',
  },
  {
    id: 'cite',
    label: 'cite',
    commandTriggers: ['cite'],
    detail: 'citation command',
    boost: 76,
    template: '\\cite\\{${1}\\}',
  },
  {
    id: 'ref',
    label: 'ref',
    commandTriggers: ['ref'],
    detail: 'reference command',
    boost: 76,
    template: '\\ref\\{${1}\\}',
  },
]

export function latexCommandSnippetCompletions(prefix: string): Completion[] {
  const normalized = normalizeTriggerPrefix(prefix)
  return LATEX_STRUCTURED_SNIPPETS.flatMap((snippet) =>
    snippet.commandTriggers
      .filter((trigger) => matchesCompletionQuery(trigger, normalized))
      .map((trigger) => ({
        trigger,
        completion: snippetCompletion(snippet.template, {
          label: `\\${trigger}`,
          detail: snippet.detail,
          type: 'keyword',
          boost: completionBoostFor(trigger, normalized, snippet.boost ?? 70),
        }),
      }))
  )
    .sort((a, b) =>
      (b.completion.boost ?? 0) - (a.completion.boost ?? 0) ||
      a.trigger.localeCompare(b.trigger),
    )
    .map((item) => item.completion)
}

export function latexCommandTriggerMatches(prefix: string): string[] {
  const normalized = normalizeTriggerPrefix(prefix)
  return LATEX_STRUCTURED_SNIPPETS.flatMap((snippet) =>
    snippet.commandTriggers.filter((trigger) => matchesCompletionQuery(trigger, normalized)),
  )
}

export function latexBeginEnvironmentSnippetCompletions(prefix: string): Completion[] {
  const normalized = normalizeTriggerPrefix(prefix)
  return LATEX_STRUCTURED_SNIPPETS.filter((snippet) =>
    snippet.beginTrigger?.startsWith(normalized),
  ).map((snippet) => snippetCompletion(snippet.template, {
    label: snippet.beginTrigger ?? snippet.label,
    detail: snippet.detail,
    type: 'class',
    boost: snippet.boost ?? 70,
  }))
}

export function latexSnippetCommandTriggers(): Set<string> {
  return new Set(LATEX_STRUCTURED_SNIPPETS.flatMap((snippet) => snippet.commandTriggers))
}

export function findLatexStructuredSnippet(id: string): LatexStructuredSnippet | undefined {
  return LATEX_STRUCTURED_SNIPPETS.find((snippet) => snippet.id === id)
}

function normalizeTriggerPrefix(prefix: string): string {
  return prefix.replace(/^\\+/, '').toLowerCase()
}

import { describe, expect, it } from 'vitest'
import { countAutomationReviewTargets } from '../stores/automationStore'
import { createDocument } from '../services/documentParser'

describe('automationStore AUTO target filtering', () => {
  it('skips only the LaTeX preamble by default', () => {
    const doc = createDocument({
      id: 'doc-auto-filter',
      name: 'paper.tex',
      format: 'tex',
      content: `\\documentclass{article}
\\usepackage{graphicx}
\\usepackage{amsmath}

\\begin{document}
\\maketitle

\\section{Intro}
This paragraph explains the research problem and gives enough prose for review.

\\label{sec:intro}
`,
    })

    expect(countAutomationReviewTargets(doc)).toBe(3)
  })

  it('keeps explicitly marked AUTO LaTeX structure', () => {
    const doc = createDocument({
      id: 'doc-auto-explicit',
      name: 'paper.tex',
      format: 'tex',
      content: `% AUTO Check whether this package setup is appropriate.
\\usepackage{graphicx}

\\begin{document}
Short.
`,
    })

    expect(countAutomationReviewTargets(doc)).toBe(2)
  })
})

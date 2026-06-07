import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMarkdown } from '../features/shared/AgentMarkdown'

describe('AgentMarkdown math rendering', () => {
  it('renders bare multi-line agent formulas as display math', () => {
    const source = String.raw`\Delta \eta_{\mathrm{MRRS}}(t_1)
=
A+(K-A)\Pr(T>t_1).`

    const html = renderToStaticMarkup(<AgentMarkdown source={source} />)

    expect(html).toContain('katex-display')
    expect(html).toContain('MRRS')
    expect(html).not.toContain('<h1>')
  })

  it('supports common LaTeX inline and display delimiters', () => {
    const source = String.raw`当 \(\bar{\alpha}_{t}>0\) 时：
\[
T=\inf\left\{t:\rho(t)\leq\tau\right\}.
\]`

    const html = renderToStaticMarkup(<AgentMarkdown source={source} />)

    expect(html).toContain('katex')
    expect(html).toContain('katex-display')
    expect(html).toContain('α')
    expect(html).toContain('τ')
    expect(html).not.toContain(String.raw`<p>T=\inf`)
  })

  it('does not leak KaTeX error text for model-style text commands', () => {
    const source = String.raw`理解成两个区域：

\textlargeenoughtosuppressharmfulcontent,butnottoolargetodestroycontext

\rho(t)\leq\tau`

    const html = renderToStaticMarkup(<AgentMarkdown source={source} />)

    expect(html).toContain('katex-display')
    expect(html).toContain('≤')
    expect(html).not.toContain('#fca5a5')
    expect(html).not.toContain(String.raw`style="color:#fca5a5;">\</span>`)
    expect(html).not.toContain(String.raw`\textlargeenoughtosuppressharmfulcontent`)
  })
})

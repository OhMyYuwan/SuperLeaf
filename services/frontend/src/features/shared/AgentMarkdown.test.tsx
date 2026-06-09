import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMarkdown } from './AgentMarkdown'

const fsPromisesSpecifier = 'node:fs/promises'
const cssUrl = new URL('./agent-markdown.css', import.meta.url)

describe('AgentMarkdown code block wrapping', () => {
  it('marks fenced code blocks for visual soft wrapping without changing content', () => {
    const longLine = 'const value = "' + 'x'.repeat(180) + '"'
    const source = ['```ts', longLine, '```'].join('\n')

    const html = renderToStaticMarkup(<AgentMarkdown source={source} />)

    expect(html).toContain('<pre class="agent-md-codepre">')
    expect(html).toContain(longLine.replaceAll('"', '&quot;'))
  })

  it('keeps code block wrapping as a display-only CSS contract', async () => {
    const { readFile } = (await import(fsPromisesSpecifier)) as {
      readFile: (path: URL, encoding: 'utf8') => Promise<string>
    }
    const agentMarkdownCss = await readFile(cssUrl, 'utf8')

    expect(agentMarkdownCss).toMatch(
      /\.agent-md\s+pre\.agent-md-codepre\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/s,
    )
  })
})

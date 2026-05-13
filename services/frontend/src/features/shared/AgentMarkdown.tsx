import { useMemo, useRef } from 'react'
import MarkdownIt from 'markdown-it'
// markdown-it-katex 2.x ships CJS with no bundled types.
// @ts-expect-error — no types
import mdKatex from 'markdown-it-katex'
import 'katex/dist/katex.min.css'
import './agent-markdown.css'

interface AgentMarkdownProps {
  source: string
  className?: string
  tone?: 'default' | 'error'
}

interface RenderedMarkdown {
  html: string
  codeBlocks: string[]
}

export function AgentMarkdown({ source, className, tone = 'default' }: AgentMarkdownProps) {
  const codeBlocksRef = useRef<string[]>([])
  const rendered = useMemo(() => renderMarkdown(source ?? ''), [source])
  codeBlocksRef.current = rendered.codeBlocks

  const handleClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest<HTMLButtonElement>('[data-agent-md-copy]')
    if (!button) return

    event.preventDefault()
    event.stopPropagation()

    const index = Number(button.dataset.codeIndex)
    const text = codeBlocksRef.current[index]
    if (Number.isNaN(index) || text === undefined) return

    try {
      await writeClipboard(text)
      const prevLabel = button.textContent ?? '复制'
      button.textContent = '已复制'
      window.setTimeout(() => {
        button.textContent = prevLabel
      }, 1600)
    } catch (err) {
      console.warn('[AgentMarkdown] copy failed', err)
    }
  }

  return (
    <div
      className={`agent-md ${tone === 'error' ? 'agent-md-error' : ''} ${className ?? ''}`}
      onClick={handleClick}
      // safe: markdown-it is configured with html=false, so raw HTML in Agent
      // output is escaped before it reaches the DOM.
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  )
}

function renderMarkdown(source: string): RenderedMarkdown {
  const codeBlocks: string[] = []
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: true,
  }).use(mdKatex, {
    throwOnError: false,
    errorColor: '#fca5a5',
  })

  const renderCodeBlock = (content: string, info = '') => {
    const index = codeBlocks.push(content) - 1
    const language = info.trim().split(/\s+/)[0] || 'text'
    const langClass = language === 'text' ? '' : ` class="language-${md.utils.escapeHtml(language)}"`
    return [
      '<div class="agent-md-codeblock">',
      '<div class="agent-md-codebar">',
      `<span class="agent-md-codelang">${md.utils.escapeHtml(language)}</span>`,
      `<button type="button" class="agent-md-copy" data-agent-md-copy data-code-index="${index}">复制</button>`,
      '</div>',
      `<pre><code${langClass}>${md.utils.escapeHtml(content)}</code></pre>`,
      '</div>',
    ].join('')
  }

  md.renderer.rules.fence = (tokens, idx) => renderCodeBlock(tokens[idx].content, tokens[idx].info)
  md.renderer.rules.code_block = (tokens, idx) => renderCodeBlock(tokens[idx].content)

  return {
    html: md.render(source),
    codeBlocks,
  }
}

async function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

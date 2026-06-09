import { useMemo } from 'react'
import MarkdownIt from 'markdown-it'
import { mdKatex } from './markdownKatex'
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
  const rendered = useMemo(() => renderMarkdown(source ?? ''), [source])

  const handleClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest<HTMLButtonElement>('[data-agent-md-copy]')
    if (!button) return

    event.preventDefault()
    event.stopPropagation()

    const index = Number(button.dataset.codeIndex)
    const text = rendered.codeBlocks[index]
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
      `<pre class="agent-md-codepre"><code${langClass}>${md.utils.escapeHtml(content)}</code></pre>`,
      '</div>',
    ].join('')
  }

  md.renderer.rules.fence = (tokens, idx) => renderCodeBlock(tokens[idx].content, tokens[idx].info)
  md.renderer.rules.code_block = (tokens, idx) => renderCodeBlock(tokens[idx].content)

  return {
    html: md.render(normalizeAgentMath(source)),
    codeBlocks,
  }
}

function normalizeAgentMath(source: string): string {
  return source
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part) => {
      if (part.startsWith('```') || part.startsWith('~~~')) return part
      return wrapBareMathBlocks(normalizeLatexDelimiters(part))
    })
    .join('')
}

function normalizeLatexDelimiters(source: string): string {
  return normalizeLooseTextCommands(source)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math: string) => `$${math.trim()}$`)
}

function normalizeLooseTextCommands(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (/^\\text(?!\s*\{)[A-Za-z][A-Za-z0-9\s,.;:'-]*$/.test(trimmed)) {
        return line.replace(trimmed, `\\text{${trimmed.slice('\\text'.length)}}`)
      }
      return line.replace(/\\text(?!\s*\{)([A-Za-z][A-Za-z0-9]*)/g, (match, text: string) => {
        if (isKnownTextCommandSuffix(text)) return match
        return `\\text{${text}}`
      })
    })
    .join('\n')
}

function isKnownTextCommandSuffix(text: string): boolean {
  return /^(bf|it|rm|sf|tt|normal|color|style|class|ord|bin|rel|open|close|punct|inner)$/.test(text)
}

function wrapBareMathBlocks(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let block: string[] = []
  let inDisplayMath = false

  const flush = () => {
    if (block.length === 0) return
    out.push('$$')
    out.push(...block)
    out.push('$$')
    block = []
  }

  for (const line of lines) {
    if (line.trim() === '$$') {
      flush()
      inDisplayMath = !inDisplayMath
      out.push(line)
      continue
    }

    if (inDisplayMath) {
      out.push(line)
      continue
    }

    if (isBareMathLine(line) || (block.length > 0 && isMathContinuationLine(line))) {
      block.push(line.trim())
      continue
    }

    flush()
    out.push(line)
  }

  flush()
  return out.join('\n')
}

function isBareMathLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (trimmed.includes('$')) return false
  if (/^[-*_]{3,}$/.test(trimmed)) return false
  if (/^([>#]|\d+\.|[-*+]\s)/.test(trimmed)) return false
  if (/[\u3400-\u9fff]/.test(trimmed)) return false
  if (!/\\[A-Za-z]+/.test(trimmed)) return false
  return /^[A-Za-z0-9\\{}()[\][\]_^+\-*/=<>.,:;|&!'\s]+$/.test(trimmed)
}

function isMathContinuationLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (trimmed.includes('$')) return false
  if (/[\u3400-\u9fff]/.test(trimmed)) return false
  return /^[A-Za-z0-9\\{}()[\][\]_^+\-*/=<>.,:;|&!'\s]+$/.test(trimmed)
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

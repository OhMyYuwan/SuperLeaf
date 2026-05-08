/**
 * MarkdownPreview — lightweight Markdown renderer.
 *
 *  - Uses `markdown-it` with html disabled and linkify enabled (safe default).
 *  - Math via `markdown-it-katex`: inline `$...$`, block `$$...$$`.
 *  - Renderer is cached at module scope — markdown-it is not cheap to init.
 *
 * The component re-renders only when `source` changes; it stamps the rendered
 * HTML via `dangerouslySetInnerHTML` because markdown-it returns a trusted
 * HTML string (html=false in the config blocks raw HTML tags in user input).
 */

import { useMemo } from 'react'
import MarkdownIt from 'markdown-it'
// markdown-it-katex 2.x ships CJS with no bundled types.
// @ts-expect-error — no types
import mdKatex from 'markdown-it-katex'
import 'katex/dist/katex.min.css'
import './markdown-preview.css'

interface MarkdownPreviewProps {
  source: string
  className?: string
}

const md = new MarkdownIt({
  html: false,       // disallow raw HTML in user input
  linkify: true,     // auto-detect URLs
  typographer: true, // smart quotes etc.
  breaks: false,     // GFM line break semantics off; authors should double-newline
})
  .use(mdKatex, {
    throwOnError: false,
    errorColor: '#fca5a5',
  })

export function MarkdownPreview({ source, className }: MarkdownPreviewProps) {
  const html = useMemo(() => md.render(source ?? ''), [source])
  return (
    <div
      className={`md-preview ${className ?? ''}`}
      // safe: html is produced by markdown-it with html=false
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

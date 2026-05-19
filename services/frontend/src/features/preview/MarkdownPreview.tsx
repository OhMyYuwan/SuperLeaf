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
import { useFilesystemStore } from '../../stores/filesystemStore'
import {
  sourceJumpFromMarkdownElement,
  stampMarkdownSourceLines,
  type SourceJump,
} from '../../services/previewSourceMap'
import { buildMarkdownAssetUrlMap, rewriteMarkdownImageSources } from './markdownAssets'
import 'katex/dist/katex.min.css'
import './markdown-preview.css'

interface MarkdownPreviewProps {
  source: string
  className?: string
  onSourceJump?: (jump: SourceJump) => void
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

export function MarkdownPreview({ source, className, onSourceJump }: MarkdownPreviewProps) {
  const tree = useFilesystemStore((state) => state.tree)
  const assetUrls = useMemo(
    () => (tree ? buildMarkdownAssetUrlMap(tree.root) : null),
    [tree],
  )

  const html = useMemo(() => {
    const tokens = md.parse(source ?? '', {})
    if (assetUrls) rewriteMarkdownImageSources(tokens, assetUrls)
    stampMarkdownSourceLines(tokens)
    return md.renderer.render(tokens, md.options, {})
  }, [assetUrls, source])

  return (
    <div
      className={`md-preview ${className ?? ''}`}
      onDoubleClick={(event) => {
        const jump = sourceJumpFromMarkdownElement(source, event.target)
        if (jump) onSourceJump?.(jump)
      }}
      // safe: html is produced by markdown-it with html=false
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

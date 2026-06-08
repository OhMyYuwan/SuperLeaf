/**
 * MarkdownPreview — lightweight Markdown renderer.
 *
 *  - Uses `markdown-it` with html disabled and linkify enabled (safe default).
 *  - Math via KaTeX: inline `$...$`, block `$$...$$`.
 *  - Mermaid fenced blocks are rendered client-side with a lazy import.
 *  - Renderer is cached at module scope — markdown-it is not cheap to init.
 *
 * The component re-renders only when `source` changes; it stamps the rendered
 * HTML via `dangerouslySetInnerHTML` because markdown-it returns a trusted
 * HTML string (html=false in the config blocks raw HTML tags in user input).
 */

import { forwardRef, useEffect, useMemo, useRef, type Ref } from 'react'
import MarkdownIt from 'markdown-it'
import { useFilesystemStore } from '../../stores/filesystemStore'
import {
  sourceJumpFromMarkdownElement,
  stampMarkdownSourceLines,
  type SourceJump,
} from '../../services/previewSourceMap'
import { mdKatex } from '../shared/markdownKatex'
import { buildMarkdownAssetUrlMap, rewriteMarkdownImageSources } from './markdownAssets'
import 'katex/dist/katex.min.css'
import './markdown-preview.css'

interface MarkdownPreviewProps {
  source: string
  className?: string
  onSourceJump?: (jump: SourceJump) => void
}

interface MermaidDiagram {
  cacheKey: string
  definition: string
}

interface MermaidRenderedDiagram {
  cacheKey: string
  svg: string
}

interface MarkdownRenderEnv {
  lastMermaidBySlot: Map<number, MermaidRenderedDiagram>
  mermaidDiagrams: MermaidDiagram[]
}

type MermaidApi = typeof import('mermaid').default

const MERMAID_RENDER_DEBOUNCE_MS = 220

let mermaidPromise: Promise<MermaidApi> | null = null
let mermaidRenderCounter = 0
const mermaidSvgCache = new Map<string, string>()

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

const defaultFenceRenderer = md.renderer.rules.fence

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const language = token.info.trim().split(/\s+/)[0]?.toLowerCase()

  if (language === 'mermaid') {
    const renderEnv = env as MarkdownRenderEnv
    const cacheKey = hashMermaidDefinition(token.content)
    const index = renderEnv.mermaidDiagrams.push({ cacheKey, definition: token.content }) - 1
    const cachedSvg = mermaidSvgCache.get(cacheKey)
    if (cachedSvg) {
      return renderMermaidShell(index, cacheKey, cachedSvg, true)
    }

    const lastRendered = renderEnv.lastMermaidBySlot.get(index)
    if (lastRendered?.svg) {
      return renderMermaidShell(index, cacheKey, lastRendered.svg, false, 'is-stale')
    }

    return [
      `<div class="md-mermaid is-loading" data-mermaid-index="${index}" data-mermaid-key="${cacheKey}">`,
      '<div class="md-mermaid-placeholder">Rendering Mermaid…</div>',
      '</div>',
    ].join('')
  }

  if (defaultFenceRenderer) {
    return defaultFenceRenderer(tokens, idx, options, env, self)
  }
  return self.renderToken(tokens, idx, options)
}

export const MarkdownPreview = forwardRef<HTMLDivElement, MarkdownPreviewProps>(function MarkdownPreview(
  { source, className, onSourceJump },
  forwardedRef,
) {
  const previewRef = useRef<HTMLDivElement | null>(null)
  const lastMermaidBySlotRef = useRef<Map<number, MermaidRenderedDiagram>>(new Map())
  const tree = useFilesystemStore((state) => state.tree)
  const assetUrls = useMemo(
    () => (tree ? buildMarkdownAssetUrlMap(tree.root) : null),
    [tree],
  )

  const { html, mermaidDiagrams } = useMemo(() => {
    const tokens = md.parse(source ?? '', {})
    if (assetUrls) rewriteMarkdownImageSources(tokens, assetUrls)
    stampMarkdownSourceLines(tokens)
    const env: MarkdownRenderEnv = {
      lastMermaidBySlot: lastMermaidBySlotRef.current,
      mermaidDiagrams: [],
    }
    return {
      html: md.renderer.render(tokens, md.options, env),
      mermaidDiagrams: env.mermaidDiagrams,
    }
  }, [assetUrls, source])

  useEffect(() => {
    const root = previewRef.current
    if (!root || mermaidDiagrams.length === 0) {
      lastMermaidBySlotRef.current = new Map()
      return
    }

    const nextSlotCache = readRenderedMermaidSlots(root)
    lastMermaidBySlotRef.current = nextSlotCache

    const targets = Array.from(
      root.querySelectorAll<HTMLElement>('.md-mermaid[data-mermaid-index]:not([data-mermaid-rendered="true"])'),
    )
    if (targets.length === 0) {
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      void renderMermaidTargets(targets, mermaidDiagrams, nextSlotCache, () => cancelled)
    }, MERMAID_RENDER_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mermaidDiagrams])

  return (
    <div
      ref={(node) => {
        previewRef.current = node
        assignRef(forwardedRef, node)
      }}
      className={`md-preview ${className ?? ''}`}
      onDoubleClick={(event) => {
        const jump = sourceJumpFromMarkdownElement(source, event.target)
        if (jump) onSourceJump?.(jump)
      }}
      // safe: html is produced by markdown-it with html=false
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

function assignRef(ref: Ref<HTMLDivElement>, value: HTMLDivElement | null) {
  if (typeof ref === 'function') {
    ref(value)
    return
  }
  if (ref) ref.current = value
}

async function renderMermaidTargets(
  targets: HTMLElement[],
  diagrams: MermaidDiagram[],
  nextSlotCache: Map<number, MermaidRenderedDiagram>,
  isCancelled: () => boolean,
) {
  try {
    const mermaid = await loadMermaid()
    for (const target of targets) {
      if (isCancelled()) return
      const index = Number(target.dataset.mermaidIndex)
      const diagram = diagrams[index]
      if (!diagram) continue

      try {
        const cachedSvg = mermaidSvgCache.get(diagram.cacheKey)
        if (cachedSvg) {
          writeMermaidSvg(target, index, diagram.cacheKey, cachedSvg)
          nextSlotCache.set(index, { cacheKey: diagram.cacheKey, svg: cachedSvg })
          continue
        }

        const renderId = `ylw-mermaid-${mermaidRenderCounter++}`
        const result = await mermaid.render(renderId, diagram.definition)
        if (isCancelled()) return
        mermaidSvgCache.set(diagram.cacheKey, result.svg)
        nextSlotCache.set(index, { cacheKey: diagram.cacheKey, svg: result.svg })
        writeMermaidSvg(target, index, diagram.cacheKey, result.svg)
        result.bindFunctions?.(target)
      } catch (err) {
        if (!isCancelled()) renderMermaidError(target, diagram.definition, err)
      }
    }
  } catch (err) {
    if (!isCancelled()) {
      for (const target of targets) {
        const index = Number(target.dataset.mermaidIndex)
        renderMermaidError(target, diagrams[index]?.definition ?? '', err)
      }
    }
  }
}

function renderMermaidShell(
  index: number,
  cacheKey: string,
  svg: string,
  rendered: boolean,
  extraClass = '',
) {
  const renderedAttr = rendered ? ' data-mermaid-rendered="true"' : ''
  return [
    `<div class="md-mermaid is-rendered ${extraClass}" data-mermaid-index="${index}" data-mermaid-key="${cacheKey}"${renderedAttr}>`,
    svg,
    '</div>',
  ].join('')
}

function readRenderedMermaidSlots(root: HTMLElement): Map<number, MermaidRenderedDiagram> {
  const nextSlotCache = new Map<number, MermaidRenderedDiagram>()
  const renderedTargets = root.querySelectorAll<HTMLElement>('.md-mermaid.is-rendered[data-mermaid-index][data-mermaid-key]')
  for (const target of renderedTargets) {
    const index = Number(target.dataset.mermaidIndex)
    const cacheKey = target.dataset.mermaidKey
    if (Number.isFinite(index) && cacheKey) {
      nextSlotCache.set(index, { cacheKey, svg: target.innerHTML })
    }
  }
  return nextSlotCache
}

function writeMermaidSvg(target: HTMLElement, index: number, cacheKey: string, svg: string) {
  target.classList.remove('is-loading', 'is-stale', 'is-error')
  target.classList.add('is-rendered')
  target.dataset.mermaidIndex = String(index)
  target.dataset.mermaidKey = cacheKey
  target.dataset.mermaidRendered = 'true'
  target.innerHTML = svg
}

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          background: '#f8fafc',
          primaryColor: '#e0f2fe',
          primaryBorderColor: '#0284c7',
          primaryTextColor: '#0f172a',
          lineColor: '#475569',
          secondaryColor: '#f1f5f9',
          tertiaryColor: '#ecfeff',
          fontFamily: 'Inter, PingFang SC, system-ui, sans-serif',
        },
      })
      return mermaid
    })
  }
  return mermaidPromise
}

function renderMermaidError(target: HTMLElement, definition: string, err: unknown) {
  target.classList.remove('is-loading', 'is-stale')
  target.classList.add('is-error')
  delete target.dataset.mermaidRendered

  const title = document.createElement('div')
  title.className = 'md-mermaid-error-title'
  title.textContent = 'Mermaid 图渲染失败'

  const message = document.createElement('div')
  message.className = 'md-mermaid-error-message'
  message.textContent = err instanceof Error ? err.message : '请检查 Mermaid 语法。'

  const source = document.createElement('pre')
  source.className = 'md-mermaid-source'
  const code = document.createElement('code')
  code.textContent = definition
  source.append(code)

  target.replaceChildren(title, message, source)
}

function hashMermaidDefinition(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `mmd-${(hash >>> 0).toString(36)}-${value.length.toString(36)}`
}

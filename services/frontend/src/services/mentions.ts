/**
 * mentions — parse @Name tokens (agents AND files) out of user-authored text.
 *
 * Candidates are a discriminated union:
 *   - agent: { kind: 'agent', id, name }
 *   - file:  { kind: 'file', id, name, path, format, size_bytes, mime?, ext? }
 *
 * Two surface syntaxes:
 *   - bare:    @MyAgent  or  @file.tex  (matched by longest-name match against
 *              the candidate list)
 *   - quoted:  @"my doc with spaces.md"  (delimits names containing whitespace,
 *              `@`, or other awkward characters — borrowed from openclaude)
 */

import type { ProjectTree, TreeDoc, TreeFile, TreeFolder } from './filesystemApi'
import { filesystemApi } from './filesystemApi'
import type { DocumentFormat } from '../types/document'

export type AgentCandidate = { kind: 'agent'; id: string; name: string; displayName?: string }
export type WorkflowCandidate = { kind: 'workflow'; id: string; name: string; description?: string }
export type FileCandidate = {
  kind: 'file'
  id: string
  name: string
  path: string
  format: 'doc' | 'binary'
  size_bytes: number
  docFormat?: 'tex' | 'md' | 'txt'
  mime?: string
  ext?: string
  /** True when this is the currently-open document; consumers may pin it to top. */
  isCurrent?: boolean
}
export type MentionCandidate = AgentCandidate | WorkflowCandidate | FileCandidate

export interface ParsedMention {
  start: number
  end: number
  candidate: MentionCandidate
  /** True when the mention used the quoted form `@"…"`. */
  quoted: boolean
}

const BOUNDARY_BEFORE = /[\s([,;:。，、；：]/

/**
 * Find all @mentions in `text` that resolve to one of the provided candidates.
 *
 * Two forms:
 *   - `@Name`            longest-prefix match against candidate names
 *   - `@"Name with @"`   anything until the closing quote
 *
 * Unmatched `@` is left as plain text. The `@` must be at string start or
 * follow whitespace/punctuation so emails like `user@host.com` don't trip.
 */
export function parseMentions(
  text: string,
  candidates: readonly MentionCandidate[],
): ParsedMention[] {
  if (candidates.length === 0) return []
  const labelsFor = (candidate: MentionCandidate): string[] => {
    if (candidate.kind === 'file' && candidate.path && candidate.path !== candidate.name) {
      return [candidate.path, candidate.name]
    }
    return [candidate.name]
  }

  const sorted = [...candidates].sort((a, b) => {
    const aMax = Math.max(...labelsFor(a).map((label) => label.length))
    const bMax = Math.max(...labelsFor(b).map((label) => label.length))
    return bMax - aMax
  })
  const byName = new Map<string, MentionCandidate>()
  for (const c of sorted) {
    for (const label of labelsFor(c)) {
      if (!byName.has(label)) byName.set(label, c)
    }
  }

  const out: ParsedMention[] = []
  let i = 0
  while (i < text.length) {
    const at = text.indexOf('@', i)
    if (at === -1) break
    if (at > 0 && !BOUNDARY_BEFORE.test(text[at - 1])) {
      i = at + 1
      continue
    }

    // Quoted form: @"…"
    if (text[at + 1] === '"') {
      const close = text.indexOf('"', at + 2)
      if (close !== -1) {
        const name = text.slice(at + 2, close)
        const match = byName.get(name)
        if (match) {
          out.push({ start: at, end: close + 1, candidate: match, quoted: true })
          i = close + 1
          continue
        }
      }
      i = at + 1
      continue
    }

    // Bare form: longest-prefix match.
    let matched: MentionCandidate | null = null
    let matchedLabel = ''
    for (const c of sorted) {
      const label = labelsFor(c).find((candidateLabel) =>
        text.startsWith(candidateLabel, at + 1),
      )
      if (label) {
        matched = c
        matchedLabel = label
        break
      }
    }
    if (matched) {
      out.push({
        start: at,
        end: at + 1 + matchedLabel.length,
        candidate: matched,
        quoted: false,
      })
      i = at + 1 + matchedLabel.length
    } else {
      i = at + 1
    }
  }
  return out
}

export function uniqueMentionedAgents(mentions: readonly ParsedMention[]): AgentCandidate[] {
  const seen = new Set<string>()
  const out: AgentCandidate[] = []
  for (const m of mentions) {
    if (m.candidate.kind !== 'agent') continue
    if (seen.has(m.candidate.id)) continue
    seen.add(m.candidate.id)
    out.push(m.candidate)
  }
  return out
}

export function uniqueMentionedWorkflows(
  mentions: readonly ParsedMention[],
): WorkflowCandidate[] {
  const seen = new Set<string>()
  const out: WorkflowCandidate[] = []
  for (const m of mentions) {
    if (m.candidate.kind !== 'workflow') continue
    if (seen.has(m.candidate.id)) continue
    seen.add(m.candidate.id)
    out.push(m.candidate)
  }
  return out
}

export function uniqueMentionedFiles(mentions: readonly ParsedMention[]): FileCandidate[] {
  const seen = new Set<string>()
  const out: FileCandidate[] = []
  for (const m of mentions) {
    if (m.candidate.kind !== 'file') continue
    if (seen.has(m.candidate.id)) continue
    seen.add(m.candidate.id)
    out.push(m.candidate)
  }
  return out
}

export type MentionSegment =
  | { type: 'text'; content: string }
  | { type: 'mention'; candidate: MentionCandidate; raw: string }

export function segmentText(
  text: string,
  mentions: readonly ParsedMention[],
): MentionSegment[] {
  if (mentions.length === 0) return text ? [{ type: 'text', content: text }] : []
  const sorted = [...mentions].sort((a, b) => a.start - b.start)
  const out: MentionSegment[] = []
  let cursor = 0
  for (const m of sorted) {
    if (m.start > cursor) {
      out.push({ type: 'text', content: text.slice(cursor, m.start) })
    }
    out.push({
      type: 'mention',
      candidate: m.candidate,
      raw: text.slice(m.start, m.end),
    })
    cursor = m.end
  }
  if (cursor < text.length) {
    out.push({ type: 'text', content: text.slice(cursor) })
  }
  return out
}

/**
 * Strip all @mentions from a string. Used before sending to an Agent so the
 * raw routing tokens don't show up in the prompt.
 */
export function stripMentions(text: string, mentions: readonly ParsedMention[]): string {
  if (mentions.length === 0) return text
  const sorted = [...mentions].sort((a, b) => b.start - a.start)
  let result = text
  for (const m of sorted) {
    result = result.slice(0, m.start) + result.slice(m.end)
  }
  return result.trim()
}

/* ------------------------------------------------------------------ files */

/** Flatten the nested project tree into a flat candidate list keyed by id. */
export function flattenFileCandidates(tree: ProjectTree | null): FileCandidate[] {
  if (!tree) return []
  const out: FileCandidate[] = []

  const walk = (folder: TreeFolder, parents: string[]) => {
    const here = folder.id === 'root' ? parents : [...parents, folder.name]
    const pathPrefix = here.join('/')
    for (const doc of folder.docs) {
      out.push(docToCandidate(doc, pathPrefix))
    }
    for (const file of folder.files) {
      out.push(fileToCandidate(file, pathPrefix))
    }
    for (const child of folder.folders) walk(child, here)
  }
  walk(tree.root, [])
  return out
}

function docToCandidate(d: TreeDoc, pathPrefix: string): FileCandidate {
  return {
    kind: 'file',
    id: d.id,
    name: d.name,
    path: pathPrefix ? `${pathPrefix}/${d.name}` : d.name,
    format: 'doc',
    size_bytes: d.size_bytes,
    docFormat: d.format,
    ext: d.format,
  }
}

function fileToCandidate(f: TreeFile, pathPrefix: string): FileCandidate {
  const ext = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase() : ''
  return {
    kind: 'file',
    id: f.id,
    name: f.name,
    path: pathPrefix ? `${pathPrefix}/${f.name}` : f.name,
    format: 'binary',
    size_bytes: f.size_bytes,
    mime: f.mime_type,
    ext,
  }
}

/**
 * Reorder file candidates so the currently-open doc (if any) is the first
 * entry, marked with `isCurrent: true` so the UI can decorate it. Everything
 * else keeps its original order.
 */
export function sortFilesCurrentFirst(
  files: readonly FileCandidate[],
  currentDocId: string | null,
): FileCandidate[] {
  if (!currentDocId) return [...files]
  const current: FileCandidate[] = []
  const others: FileCandidate[] = []
  for (const f of files) {
    if (f.id === currentDocId) current.push({ ...f, isCurrent: true })
    else others.push(f)
  }
  return [...current, ...others]
}

/* -------------------------------------------------------------- truncation */

export const PER_FILE_CAP_BYTES = 50 * 1024
export const TOTAL_BUDGET_BYTES = 200 * 1024
export const SOFT_WARN_BYTES = 1024 * 1024
export const HARD_REJECT_BYTES = 50 * 1024 * 1024

/**
 * UTF-8-safe byte-level truncation. We slice the byte buffer then decode
 * tolerantly so we never split a multi-byte codepoint.
 */
export function truncateForLLM(
  content: string,
  capBytes: number,
): { content: string; truncated: boolean; originalBytes: number } {
  const enc = new TextEncoder()
  const dec = new TextDecoder('utf-8', { fatal: false })
  const bytes = enc.encode(content)
  if (bytes.length <= capBytes) {
    return { content, truncated: false, originalBytes: bytes.length }
  }
  const head = dec.decode(bytes.slice(0, capBytes))
  const originalKB = Math.round(bytes.length / 1024)
  const keptKB = Math.round(capBytes / 1024)
  return {
    content: `${head}\n[...内容已截断，原文 ${originalKB} KB，仅保留前 ${keptKB} KB]`,
    truncated: true,
    originalBytes: bytes.length,
  }
}

/* -------------------------------------------------------------- resolve */

export interface AttachedFile {
  name: string
  path: string
  kind: 'doc' | 'binary'
  content?: string
  truncated?: boolean
  original_size_bytes: number
  mime?: string
  url?: string
  /** Set when this file was reduced to a stub because total budget was hit. */
  omitted?: boolean
  omit_reason?: string
}

export interface ResolveAttachedFilesOptions {
  /**
   * Called when a file fetch fails. The caller can surface a toast or just
   * silently drop the attachment.
   */
  onFetchError?: (file: FileCandidate, error: unknown) => void
  /** Override per-file cap (mostly for tests). */
  perFileCap?: number
  /** Override total budget (mostly for tests). */
  totalBudget?: number
}

/**
 * Resolve mentioned files into ready-to-ship `AttachedFile` payloads.
 *
 * Pipeline:
 *   1. For each candidate, fetch text content via filesystemApi.getDoc (docs)
 *      or build a metadata stub (binary).
 *   2. Apply per-file truncation cap to text content.
 *   3. Once running total exceeds `totalBudget`, downgrade remaining files to
 *      omitted stubs so the request can still go out.
 *   4. Failed fetches (deleted file etc.) are dropped and reported via
 *      onFetchError so the UI can toast.
 */
export async function resolveAttachedFiles(
  candidates: readonly FileCandidate[],
  opts: ResolveAttachedFilesOptions = {},
): Promise<AttachedFile[]> {
  const perFileCap = opts.perFileCap ?? PER_FILE_CAP_BYTES
  const totalBudget = opts.totalBudget ?? TOTAL_BUDGET_BYTES

  const fetched = await Promise.all(
    candidates.map(async (c) => {
      if (c.format === 'binary') {
        const stub: AttachedFile = {
          name: c.name,
          path: c.path,
          kind: 'binary',
          original_size_bytes: c.size_bytes,
          mime: c.mime,
          url: filesystemApi.fileUrl(c.id),
        }
        return { candidate: c, attached: stub, ok: true as const }
      }
      try {
        const doc = await filesystemApi.getDoc(c.id)
        const truncated = truncateForLLM(doc.content ?? '', perFileCap)
        const attached: AttachedFile = {
          name: c.name,
          path: c.path,
          kind: 'doc',
          content: truncated.content,
          truncated: truncated.truncated,
          original_size_bytes: truncated.originalBytes,
        }
        return { candidate: c, attached, ok: true as const }
      } catch (err) {
        opts.onFetchError?.(c, err)
        return { candidate: c, attached: null, ok: false as const }
      }
    }),
  )

  const out: AttachedFile[] = []
  let used = 0
  for (const r of fetched) {
    if (!r.ok || !r.attached) continue
    const cost = r.attached.kind === 'doc' ? (r.attached.content?.length ?? 0) : 0
    if (used + cost > totalBudget && r.attached.kind === 'doc') {
      out.push({
        name: r.attached.name,
        path: r.attached.path,
        kind: 'doc',
        original_size_bytes: r.attached.original_size_bytes,
        omitted: true,
        omit_reason: 'total attachment budget exceeded',
      })
      continue
    }
    used += cost
    out.push(r.attached)
  }
  return out
}

/* ----------------------------------------------------------- agent prompt */

/**
 * Build the prompt sent to an Agent when triggered by a user comment.
 *
 * Layered: target passage → attached files → thread history → user question.
 */
export function buildAgentPrompt({
  targetText,
  userMessage,
  threadHistory,
  attachedFiles,
  documentFormat,
}: {
  targetText: string
  userMessage: string
  threadHistory: Array<{ role: 'user' | 'agent'; content: string; agentName?: string }>
  attachedFiles?: readonly AttachedFile[]
  documentFormat?: DocumentFormat
}): string {
  const lines: string[] = []
  lines.push(buildPanelReplyContract({ targetText, userMessage, documentFormat }))
  lines.push('')
  if (targetText.trim()) {
    lines.push('上下文（正文被批注的片段）:')
    lines.push(targetText.trim())
    lines.push('')
  }
  if (attachedFiles && attachedFiles.length > 0) {
    lines.push('[ATTACHED FILES]')
    for (const f of attachedFiles) {
      const header = formatFileHeader(f)
      lines.push(header)
      if (f.omitted) {
        lines.push(`[file omitted: ${f.omit_reason ?? 'budget exceeded'}]`)
      } else if (f.kind === 'doc') {
        lines.push(f.content ?? '')
      } else {
        lines.push('（二进制文件已通过多模态附件传递；若 Agent 不支持视觉则只能看到此元数据）')
      }
      lines.push(`[END FILE: ${f.name}]`)
    }
    lines.push('[END ATTACHED FILES]')
    lines.push('')
  }
  if (threadHistory.length > 0) {
    lines.push('此批注已有的交流:')
    for (const m of threadHistory) {
      const label = m.role === 'user' ? '用户' : m.agentName ? `@${m.agentName}` : 'Agent'
      lines.push(`- ${label}: ${m.content}`)
    }
    lines.push('')
  }
  lines.push('当前提问:')
  lines.push(userMessage)
  return lines.join('\n')
}

function buildPanelReplyContract({
  targetText,
  userMessage,
  documentFormat,
}: {
  targetText: string
  userMessage: string
  documentFormat?: DocumentFormat
}): string {
  const sourceFormat = inferSourceFormat(`${targetText}\n${userMessage}`, documentFormat)
  return [
    '[REPLY FORMAT]',
    '- 主要回答直接用 Markdown。',
    '- 不要输出 JSON，也不要把内容拆成 annotations/suggestions/risks 或多张批注。',
    `- 如果给出可替换文本，只放在一个 fenced code block 中；代码块内容保持${sourceFormat.label}源格式，围栏语言建议：${sourceFormat.fence}.`,
    '[END REPLY FORMAT]',
  ].join('\n')
}

function inferSourceFormat(
  text: string,
  documentFormat?: DocumentFormat,
): { label: string; fence: 'latex' | 'markdown' | 'text' } {
  const sample = text.trim()
  if (looksLikeLatex(sample)) return { label: ' LaTeX ', fence: 'latex' }
  if (looksLikeMarkdown(sample)) return { label: ' Markdown ', fence: 'markdown' }
  if (documentFormat === 'tex') return { label: ' LaTeX ', fence: 'latex' }
  if (documentFormat === 'md') return { label: ' Markdown ', fence: 'markdown' }
  return { label: '纯文本', fence: 'text' }
}

function looksLikeLatex(text: string): boolean {
  return /\\(?:begin|end|section|subsection|subsubsection|paragraph|cite|ref|label|textbf|emph|item)\b/u.test(text)
    || /\\[a-zA-Z]+\s*\{/u.test(text)
    || /\$(?:\\.|[^$\n])+\$/u.test(text)
}

function looksLikeMarkdown(text: string): boolean {
  return /^#{1,6}\s+\S/mu.test(text)
    || /^>\s+\S/mu.test(text)
    || /^ {0,3}(?:[-*+]|\d+\.)\s+\S/mu.test(text)
    || /\[[^\]]+\]\([^)]+\)/u.test(text)
    || /(?:^|\n)```/u.test(text)
    || /\*\*[^*\n][\s\S]*?\*\*/u.test(text)
}

function formatFileHeader(f: AttachedFile): string {
  const parts: string[] = [`[FILE: ${f.name}`, `kind=${f.kind}`]
  parts.push(`size=${f.original_size_bytes}B`)
  if (f.truncated) parts.push('truncated=true')
  if (f.kind === 'binary' && f.mime) parts.push(`mime=${f.mime}`)
  if (f.kind === 'binary' && f.url) parts.push(`url=${f.url}`)
  return parts.join(' | ') + ']'
}

/**
 * Format a candidate as the literal text that should be inserted into a
 * textarea. Names with whitespace / `@` / non-ASCII punctuation get the
 * quoted form to keep the parser happy.
 */
export function formatInsertion(c: MentionCandidate): string {
  const label = c.kind === 'file' ? c.path || c.name : c.name
  const needsQuote = /[\s"@]/.test(label)
  return needsQuote ? `@"${label}" ` : `@${label} `
}

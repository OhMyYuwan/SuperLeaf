/**
 * DocumentParser — 从 content（字符串）解析出 DocumentStructure。
 *
 * 支持三种格式：
 *  - tex: 解析 \section / \subsection / \subsubsection / \paragraph / \cite
 *  - md:  解析 # / ## / ### / #### 标题 + [^xxx] 引用
 *  - txt: 按空行切分段落，不识别章节
 *
 * 稳定段落 ID 策略：基于"章节路径 + 段落在章节内的顺序 + 首 32 字符 hash"。
 * 这样在纯编辑场景下 ID 稳定，在段落插入/删除时会变化，是可以接受的折中。
 */

import type {
  Document,
  DocumentFormat,
  DocumentStructure,
  Paragraph,
  Section,
  Citation,
} from '../types/document'

interface RawHeading {
  level: number
  title: string
  from: number
  to: number
}

const LATEX_HEADING_LEVELS: Record<string, number> = {
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
}

export function parseDocument(content: string, format: DocumentFormat): DocumentStructure {
  switch (format) {
    case 'tex':
      return parseLatex(content)
    case 'md':
      return parseMarkdown(content)
    case 'txt':
    default:
      return parsePlainText(content)
  }
}

function parseLatex(content: string): DocumentStructure {
  const headings: RawHeading[] = []
  const citations: Citation[] = []

  const headingRegex = /\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = headingRegex.exec(content)) !== null) {
    const level = LATEX_HEADING_LEVELS[match[1]] ?? 1
    headings.push({
      level,
      title: match[2].trim(),
      from: match.index,
      to: match.index + match[0].length,
    })
  }

  const citeRegex = /\\cite[pt]?\*?\{([^}]+)\}/g
  while ((match = citeRegex.exec(content)) !== null) {
    const keys = match[1].split(',').map((k) => k.trim()).filter(Boolean)
    const startOffset = match.index + match[0].indexOf('{') + 1
    for (const key of keys) {
      const keyPos = content.indexOf(key, startOffset)
      citations.push({
        id: `cite-${citations.length}-${key}`,
        key,
        range: { from: keyPos, to: keyPos + key.length },
      })
    }
  }

  const sections = buildSectionTree(headings)
  const paragraphs = splitParagraphs(content, sections)
  return { sections, paragraphs, citations }
}

function parseMarkdown(content: string): DocumentStructure {
  const headings: RawHeading[] = []
  const citations: Citation[] = []

  const lines = content.split('\n')
  let offset = 0
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (h) {
      headings.push({
        level: h[1].length - 1,
        title: h[2].trim(),
        from: offset,
        to: offset + line.length,
      })
    }
    offset += line.length + 1
  }

  const citeRegex = /\[\^([^\]]+)\]/g
  let match: RegExpExecArray | null
  while ((match = citeRegex.exec(content)) !== null) {
    citations.push({
      id: `cite-${citations.length}-${match[1]}`,
      key: match[1],
      range: { from: match.index, to: match.index + match[0].length },
    })
  }

  const sections = buildSectionTree(headings)
  const paragraphs = splitParagraphs(content, sections)
  return { sections, paragraphs, citations }
}

function parsePlainText(content: string): DocumentStructure {
  const paragraphs = splitParagraphs(content, [])
  return { sections: [], paragraphs, citations: [] }
}

/**
 * 基于 heading 列表构造有父子关系的 Section 树。
 */
function buildSectionTree(headings: RawHeading[]): Section[] {
  const sections: Section[] = []
  const stack: Section[] = []

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    const endOfContent = headings[i + 1]?.from ?? Number.MAX_SAFE_INTEGER
    const section: Section = {
      id: `sec-${i}-${slugify(h.title)}`,
      title: h.title,
      range: { from: h.from, to: endOfContent },
      level: h.level,
      children: [],
    }

    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop()
    }
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(section.id)
    }
    sections.push(section)
    stack.push(section)
  }

  return sections
}

/**
 * 按空行切分段落。遇到 heading 行时把它"挖掉"，不让它吞并紧跟的正文。
 * 每个段落自动归属到包含它的最深 section。
 */
function splitParagraphs(content: string, sections: Section[]): Paragraph[] {
  const paragraphs: Paragraph[] = []
  let index = 0

  const lines: Array<{ from: number; to: number; text: string; isHeading: boolean }> = []
  let offset = 0
  for (const line of content.split('\n')) {
    lines.push({
      from: offset,
      to: offset + line.length,
      text: line,
      isHeading: isHeadingLine(line),
    })
    offset += line.length + 1
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.isHeading || line.text.trim() === '') {
      i++
      continue
    }

    const startIdx = i
    while (i < lines.length && lines[i].text.trim() !== '' && !lines[i].isHeading) {
      i++
    }
    const endIdx = i - 1

    const from = lines[startIdx].from
    const to = lines[endIdx].to
    const text = content.slice(from, to)

    const parent = findDeepestSection(sections, from)
    const shortHash = stableHash(text.slice(0, 32))
    paragraphs.push({
      id: `p-${index}-${shortHash}`,
      range: { from, to },
      text,
      level: parent?.level ?? 0,
      parentSection: parent?.id,
    })
    index++
  }

  return paragraphs
}

function isHeadingLine(text: string): boolean {
  const trimmed = text.trim()
  if (/^#{1,6}\s+/.test(trimmed)) return true
  if (/^\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{/.test(trimmed)) return true
  return false
}

function findDeepestSection(sections: Section[], pos: number): Section | undefined {
  let best: Section | undefined
  for (const s of sections) {
    if (pos >= s.range.from && pos < s.range.to) {
      if (!best || s.level > best.level) best = s
    }
  }
  return best
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
}

/**
 * 简易字符串哈希，返回 6 字符十六进制。不用于加密，只用于段落 ID 可读性。
 */
function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0').slice(0, 6)
}

export function createDocument(params: {
  id: string
  name: string
  content: string
  format: DocumentFormat
}): Document {
  const now = new Date()
  return {
    id: params.id,
    format: params.format,
    content: params.content,
    structure: parseDocument(params.content, params.format),
    metadata: {
      title: params.name,
      author: 'user',
      created: now,
      modified: now,
      tags: [],
    },
    version: 1,
  }
}

/**
 * SelectionContextExtractor — 从 Document + 选区位置，派生出供 Agent 消费的
 * SelectionContext（前文/后文/所属章节/覆盖段落 IDs）。
 *
 * 这是 Layer 1 与 Layer 2 之间的适配层：编辑器只需上报 {from, to}，
 * 其余上下文由本模块从 Document.structure 组装。
 */

import type { Document, Paragraph, Section } from '../types/document'
import type { Selection, SelectionContext } from '../types/editor'

const DEFAULT_CONTEXT_WINDOW = 400

interface ExtractOptions {
  contextWindow?: number  // 前后文各取多少字符
  includeFullDocument?: boolean
}

export function extractSelection(
  doc: Document,
  range: { from: number; to: number },
  options: ExtractOptions = {},
): Selection {
  const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const from = Math.max(0, Math.min(range.from, range.to))
  const to = Math.min(doc.content.length, Math.max(range.from, range.to))

  const text = doc.content.slice(from, to)
  const paragraphIds = paragraphsInRange(doc.structure.paragraphs, from, to).map((p) => p.id)
  const deepestSection = findDeepestSection(doc.structure.sections, from)

  const before = doc.content.slice(Math.max(0, from - contextWindow), from)
  const after = doc.content.slice(to, Math.min(doc.content.length, to + contextWindow))

  const context: SelectionContext = {
    before,
    after,
    sectionTitle: deepestSection?.title,
    sectionId: deepestSection?.id,
    fullDocument: options.includeFullDocument ? doc.content : undefined,
    selectionLength: to - from,
    paragraphCount: paragraphIds.length,
  }

  return {
    from,
    to,
    text,
    paragraphIds,
    context,
  }
}

function paragraphsInRange(paragraphs: Paragraph[], from: number, to: number): Paragraph[] {
  return paragraphs.filter((p) => p.range.from < to && p.range.to > from)
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

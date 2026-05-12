/**
 * evaluationContext — assemble the `context` blob saved alongside an
 * AgentEvaluation (V3 Phase 4 task 4.2).
 *
 * Captures everything that makes the evaluation reproducible later WITHOUT
 * persisting the full document (cap each excerpt at 1200 chars). The hash
 * lets future analysis confirm the document version matches even if the
 * full text is gone.
 */

import type { Document } from '../types/document'
import type { AgentEvaluation, AnnotationItem, ThreadMessage } from '../stores/annotationStore'

const EXCERPT_MAX = 1200
const SURROUND_MAX = 400

export interface CapturedContext {
  document_id: string
  document_hash: string
  document_format: string
  section: string | null
  task_scope: 'annotation_followup'
  annotation_id: string
  annotation_kind: string
  annotation_text: string
  target_text: string
  surrounding_before: string
  surrounding_after: string
  agent_id: string | null
  agent_name: string | null
  workflow_id: string | null
  workflow_run_id: string | null
  prompt_hash: string | null
  input_excerpt: string
  output_excerpt: string
  created_from: 'annotation_panel'
  captured_at: string
  [key: string]: unknown
}

export function captureEvaluationContext(
  item: AnnotationItem,
  doc: Document | null,
): CapturedContext {
  const content = doc?.content ?? ''
  const section = doc ? findSectionTitle(doc, item.range.from) : null
  const surroundingBefore = content
    ? excerpt(content.slice(Math.max(0, item.range.from - SURROUND_MAX), item.range.from), SURROUND_MAX)
    : ''
  const surroundingAfter = content
    ? excerpt(content.slice(item.range.to, item.range.to + SURROUND_MAX), SURROUND_MAX)
    : ''

  const { input, output } = extractIo(item.thread)

  return {
    document_id: item.documentId,
    document_hash: doc ? fnv1a32(doc.content) : '',
    document_format: doc?.format ?? 'unknown',
    section,
    task_scope: 'annotation_followup',
    annotation_id: item.id,
    annotation_kind: item.kind,
    annotation_text: excerpt(item.content, EXCERPT_MAX),
    target_text: excerpt(item.targetText, EXCERPT_MAX),
    surrounding_before: surroundingBefore,
    surrounding_after: surroundingAfter,
    agent_id: item.workflowId || null,
    agent_name: item.agentName || null,
    workflow_id: item.workflowId || null,
    workflow_run_id: null,
    prompt_hash: null,
    input_excerpt: input,
    output_excerpt: output,
    created_from: 'annotation_panel',
    captured_at: new Date().toISOString(),
  }
}

/** Last user message and last agent message in the thread, as excerpts. */
function extractIo(thread: ThreadMessage[]): { input: string; output: string } {
  let lastUser = ''
  let lastAgent = ''
  for (const m of thread) {
    if (m.role === 'user') lastUser = m.content
    else if (m.role === 'agent') lastAgent = m.content
  }
  return {
    input: excerpt(lastUser, EXCERPT_MAX),
    output: excerpt(lastAgent, EXCERPT_MAX),
  }
}

function findSectionTitle(doc: Document, offset: number): string | null {
  const sections = doc.structure?.sections ?? []
  // Sections are a flat list; `children` is just an ID array. Containment
  // + deepest level wins so a `\subsection` beats its enclosing `\section`.
  let best: { title: string; level: number } | null = null
  for (const s of sections) {
    if (s.range.from <= offset && offset <= s.range.to) {
      if (!best || s.level > best.level) {
        best = { title: s.title, level: s.level }
      }
    }
  }
  return best ? best.title : null
}

/** Truncate to UTF-16 char count with a tail marker so readers know more
 *  content existed at evaluation time. */
export function excerpt(text: string, max: number): string {
  if (!text) return ''
  if (text.length <= max) return text
  const dropped = text.length - max
  return `${text.slice(0, max)}…[+${dropped}]`
}

/** FNV-1a 32-bit hash → 8 hex chars. Not cryptographic; just enough to
 *  distinguish document versions for replay verification later. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Convenience helper — patch a Partial<AgentEvaluation> with the captured
 *  context. The caller assembles the rest of the eval (verdict/reason/etc). */
export function withCapturedContext(
  draft: Omit<AgentEvaluation, 'id' | 'annotationId' | 'createdAt' | 'updatedAt' | 'context'>,
  item: AnnotationItem,
  doc: Document | null,
): Omit<AgentEvaluation, 'id' | 'annotationId' | 'createdAt' | 'updatedAt'> {
  return { ...draft, context: captureEvaluationContext(item, doc) }
}

/**
 * outputParser — coerce Dify's run output (text or structured) into
 * Annotation / Suggestion / Risk records.
 *
 * Dify workflows can be authored to emit:
 *   1. Strict structured JSON in workflow_finished.outputs (preferred).
 *      Schema: { annotations: [...], suggestions: [...], risks: [...] }
 *   2. A single string field (e.g. `result`, `text`) containing JSON we can
 *      pull out of a fenced block.
 *   3. Free-form natural language (chat-mode default).
 *
 * For (3) we fall back to a single `comment` annotation that anchors to the
 * original selection — the user still gets a card to Accept / Delete / Continue.
 *
 * Coordinates: Dify produces local indices relative to the selection (0..N).
 * Callers must offset by `range.from` before storing, since the editor uses
 * absolute document positions.
 */

import type { Annotation, Risk, Suggestion } from '../types/agent'
import { uuid } from '../lib/uuid'

export interface ParsedAgentOutput {
  annotations: Omit<Annotation, 'agentId'>[]
  suggestions: Omit<Suggestion, 'agentId'>[]
  risks: Omit<Risk, 'agentId'>[]
  rawText?: string  // verbatim chat answer or fallback text
}

export interface ParseContext {
  range: { from: number; to: number }
  selectionText: string
}

interface RawAnnotation {
  from?: number
  to?: number
  content?: string
  text?: string
  type?: string
  severity?: string
  tags?: string[]
}

interface RawSuggestion {
  from?: number
  to?: number
  original?: string
  proposed?: string
  reason?: string
  confidence?: number
}

interface RawRisk {
  from?: number
  to?: number
  risk_type?: string
  riskType?: string
  severity?: string
  description?: string
  mitigation?: string
}

export function parseDifyOutputs(outputs: unknown, ctx: ParseContext): ParsedAgentOutput {
  const text = pickAnswerText(outputs)
  const structured = pickStructured(outputs)

  if (structured) {
    return finalize(structured, ctx, text)
  }

  if (text) {
    const fromCodeBlock = extractJsonFromCodeBlock(text)
    if (fromCodeBlock) {
      return finalize(fromCodeBlock, ctx, text)
    }
    // Last resort: render the whole text as a single comment anchored to the selection.
    return {
      annotations: [
        {
          id: uuid(),
          targetRange: { from: ctx.range.from, to: ctx.range.to },
          targetText: ctx.selectionText,
          content: text.trim(),
          type: 'comment',
          severity: 'medium',
          tags: [],
          resolved: false,
          createdAt: new Date(),
        },
      ],
      suggestions: [],
      risks: [],
      rawText: text,
    }
  }

  return { annotations: [], suggestions: [], risks: [] }
}

// --- helpers ---------------------------------------------------------------

function pickAnswerText(outputs: unknown): string {
  if (typeof outputs === 'string') return outputs
  if (!outputs || typeof outputs !== 'object') return ''
  const obj = outputs as Record<string, unknown>
  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.answer === 'string') return obj.answer
  if (typeof obj.result === 'string') return obj.result
  // Sometimes outputs.outputs.text holds the chat answer alongside structured.
  const inner = obj.outputs as Record<string, unknown> | undefined
  if (inner && typeof inner.text === 'string') return inner.text
  return ''
}

function pickStructured(outputs: unknown): {
  annotations?: RawAnnotation[]
  suggestions?: RawSuggestion[]
  risks?: RawRisk[]
} | null {
  if (!outputs || typeof outputs !== 'object') return null
  const obj = outputs as Record<string, unknown>
  // Direct hit at top level.
  if (Array.isArray(obj.annotations) || Array.isArray(obj.suggestions) || Array.isArray(obj.risks)) {
    return obj as { annotations?: RawAnnotation[]; suggestions?: RawSuggestion[]; risks?: RawRisk[] }
  }
  // Nested under outputs.outputs (chat-mode metadata path).
  const inner = obj.outputs as Record<string, unknown> | undefined
  if (inner && (Array.isArray(inner.annotations) || Array.isArray(inner.suggestions) || Array.isArray(inner.risks))) {
    return inner as { annotations?: RawAnnotation[]; suggestions?: RawSuggestion[]; risks?: RawRisk[] }
  }
  return null
}

function extractJsonFromCodeBlock(text: string): {
  annotations?: RawAnnotation[]
  suggestions?: RawSuggestion[]
  risks?: RawRisk[]
} | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenceMatch ? fenceMatch[1] : findBareJsonObject(text)
  if (!candidate) return null
  try {
    const parsed = JSON.parse(candidate)
    if (parsed && typeof parsed === 'object') {
      return parsed as { annotations?: RawAnnotation[]; suggestions?: RawSuggestion[]; risks?: RawRisk[] }
    }
  } catch {
    return null
  }
  return null
}

function findBareJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

function finalize(
  raw: { annotations?: RawAnnotation[]; suggestions?: RawSuggestion[]; risks?: RawRisk[] },
  ctx: ParseContext,
  rawText?: string,
): ParsedAgentOutput {
  const offset = ctx.range.from
  const selLen = ctx.range.to - ctx.range.from

  const clampRange = (from?: number, to?: number) => {
    const f = Math.max(0, Math.min(typeof from === 'number' ? from : 0, selLen))
    const t = Math.max(f + 1, Math.min(typeof to === 'number' ? to : selLen, selLen))
    return { from: offset + f, to: offset + t }
  }

  const annotations = (raw.annotations ?? []).map<Omit<Annotation, 'agentId'>>((a) => ({
    id: uuid(),
    targetRange: clampRange(a.from, a.to),
    targetText: ctx.selectionText.slice(a.from ?? 0, a.to ?? selLen),
    content: a.content ?? a.text ?? '',
    type: normalizeAnnType(a.type),
    severity: normalizeSeverity(a.severity),
    tags: a.tags ?? [],
    resolved: false,
    createdAt: new Date(),
  }))

  const suggestions = (raw.suggestions ?? []).map<Omit<Suggestion, 'agentId'>>((s) => ({
    id: uuid(),
    targetRange: clampRange(s.from, s.to),
    original: s.original ?? ctx.selectionText.slice(s.from ?? 0, s.to ?? selLen),
    proposed: s.proposed ?? '',
    reason: s.reason ?? '',
    confidence: typeof s.confidence === 'number' ? s.confidence : 0.6,
    status: 'pending',
    createdAt: new Date(),
  }))

  const risks = (raw.risks ?? []).map<Omit<Risk, 'agentId'>>((r) => ({
    id: uuid(),
    targetRange: clampRange(r.from, r.to),
    riskType: normalizeRiskType(r.risk_type ?? r.riskType),
    severity: normalizeSeverity(r.severity) ?? 'medium',
    description: r.description ?? '',
    mitigation: r.mitigation,
    createdAt: new Date(),
  }))

  return { annotations, suggestions, risks, rawText }
}

function normalizeAnnType(value: string | undefined): Annotation['type'] {
  switch ((value ?? 'comment').toLowerCase()) {
    case 'question':
      return 'question'
    case 'praise':
      return 'praise'
    case 'warning':
      return 'warning'
    default:
      return 'comment'
  }
}

function normalizeSeverity(value: string | undefined): Annotation['severity'] {
  const v = (value ?? '').toLowerCase()
  if (v === 'low' || v === 'medium' || v === 'high') return v
  if (v === 'critical') return 'high'
  return 'medium'
}

function normalizeRiskType(value: string | undefined): Risk['riskType'] {
  switch ((value ?? '').toLowerCase()) {
    case 'logic':
    case 'citation':
    case 'clarity':
    case 'style':
    case 'factual':
    case 'consistency':
      return value!.toLowerCase() as Risk['riskType']
    default:
      return 'clarity'
  }
}

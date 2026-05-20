/**
 * outputParser — coerce Dify's run output (text or structured) into
 * Annotation / Suggestion / Risk records.
 *
 * Dify workflows can be authored to emit:
 *   1. Strict structured JSON in workflow_finished.outputs (preferred).
 *      Preferred schema: { annotations: [...] }
 *   2. A single string field (e.g. `result`, `text`) containing JSON we can
 *      pull out of a fenced block.
 *   3. Free-form natural language (chat-mode default).
 *
 * Legacy `suggestions` and `risks` arrays are accepted for compatibility, but
 * normalized into normal annotation cards. The annotation panel no longer
 * creates separate suggestion/risk card kinds for Agent output.
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
  content?: string
  text?: string
  original?: string
  proposed?: string
  reason?: string
  severity?: string
  tags?: string[]
  confidence?: number
}

interface RawRisk {
  from?: number
  to?: number
  content?: string
  text?: string
  risk_type?: string
  riskType?: string
  severity?: string
  description?: string
  mitigation?: string
  tags?: string[]
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

  const makeAnnotation = (
    from: number | undefined,
    to: number | undefined,
    content: string,
    type: Annotation['type'],
    severity: Annotation['severity'],
    tags: string[],
  ): Omit<Annotation, 'agentId'> | null => {
    const trimmed = content.trim()
    if (!trimmed) return null
    const localFrom = Math.max(0, Math.min(typeof from === 'number' ? from : 0, selLen))
    const localTo = Math.max(localFrom + 1, Math.min(typeof to === 'number' ? to : selLen, selLen))
    return {
      id: uuid(),
      targetRange: clampRange(from, to),
      targetText: ctx.selectionText.slice(localFrom, localTo),
      content: trimmed,
      type,
      severity,
      tags,
      resolved: false,
      createdAt: new Date(),
    }
  }

  const annotations = [
    ...(raw.annotations ?? []).map((a) => makeAnnotation(
      a.from,
      a.to,
      a.content ?? a.text ?? '',
      normalizeAnnType(a.type),
      normalizeSeverity(a.severity),
      a.tags ?? [],
    )),
    ...(raw.suggestions ?? []).map((s) => makeAnnotation(
      s.from,
      s.to,
      suggestionContent(s),
      'comment',
      normalizeSeverity(s.severity),
      s.tags ?? [],
    )),
    ...(raw.risks ?? []).map((r) => makeAnnotation(
      r.from,
      r.to,
      riskContent(r),
      'warning',
      normalizeSeverity(r.severity),
      r.tags ?? [],
    )),
  ].filter((item): item is Omit<Annotation, 'agentId'> => item !== null)

  return { annotations, suggestions: [], risks: [], rawText }
}

function suggestionContent(value: RawSuggestion): string {
  const direct = cleanText(value.content ?? value.text)
  if (direct) return direct

  const original = cleanText(value.original)
  const proposed = cleanText(value.proposed)
  const reason = cleanText(value.reason)
  const parts: string[] = []
  if (original && proposed) parts.push(`建议改写：${original} → ${proposed}`)
  else if (proposed) parts.push(`建议改写为：${proposed}`)
  if (reason) parts.push(`理由：${reason}`)
  return parts.join('\n')
}

function riskContent(value: RawRisk): string {
  const direct = cleanText(value.content ?? value.text)
  if (direct) return direct

  const description = cleanText(value.description)
  const mitigation = cleanText(value.mitigation)
  const riskType = normalizeRiskType(value.risk_type ?? value.riskType)
  const parts: string[] = []
  if (description) parts.push(`风险（${riskType}）：${description}`)
  if (mitigation) parts.push(`建议处理：${mitigation}`)
  return parts.join('\n')
}

function cleanText(value: string | undefined): string {
  return (value ?? '').trim()
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

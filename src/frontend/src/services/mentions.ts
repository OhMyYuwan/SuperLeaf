/**
 * mentions — parse @AgentName tokens out of user-authored comments.
 *
 * We intentionally keep this dumb: an @ mention is the literal character `@`
 * followed by a non-whitespace run (letters / digits / CJK / punctuation
 * except whitespace). Agent names may contain spaces, so the caller provides
 * the list of known agents and we match the LONGEST one at each `@`.
 */

export interface MentionCandidate {
  id: string
  name: string
}

export interface ParsedMention {
  // Character offsets in the source string.
  start: number
  end: number
  agent: MentionCandidate
}

/**
 * Find all @mentions in `text` that resolve to one of the provided agents.
 *
 * For each `@` we try the longest-matching known agent name at that position.
 * If nothing matches (e.g. the user typed `@foo` but no Agent is named "foo"),
 * the `@` is ignored — it stays as plain text.
 */
export function parseMentions(
  text: string,
  agents: readonly MentionCandidate[],
): ParsedMention[] {
  if (agents.length === 0) return []
  // Sort by name length descending so "@Reviewer Pro" is preferred over "@Reviewer".
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length)

  const out: ParsedMention[] = []
  let i = 0
  while (i < text.length) {
    const at = text.indexOf('@', i)
    if (at === -1) break
    // Require that the @ is at the start OR preceded by whitespace/punctuation,
    // so emails like user@host.com don't trip it.
    if (at > 0) {
      const prev = text[at - 1]
      if (!/[\s\(\[,;:。，、；：]/.test(prev)) {
        i = at + 1
        continue
      }
    }
    let matched: MentionCandidate | null = null
    for (const a of sorted) {
      if (text.startsWith(a.name, at + 1)) {
        matched = a
        break
      }
    }
    if (matched) {
      out.push({ start: at, end: at + 1 + matched.name.length, agent: matched })
      i = at + 1 + matched.name.length
    } else {
      i = at + 1
    }
  }
  return out
}

/**
 * Deduplicate mentions by agent id, preserving order of first occurrence.
 */
export function uniqueMentionedAgents(mentions: readonly ParsedMention[]): MentionCandidate[] {
  const seen = new Set<string>()
  const out: MentionCandidate[] = []
  for (const m of mentions) {
    if (seen.has(m.agent.id)) continue
    seen.add(m.agent.id)
    out.push(m.agent)
  }
  return out
}

/**
 * Segments a string into plain-text and mention spans, in order. Used by the
 * renderer to draw highlighted tags inline.
 */
export type MentionSegment =
  | { type: 'text'; content: string }
  | { type: 'mention'; agent: MentionCandidate; raw: string }

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
      agent: m.agent,
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
 * Strip all @mentions from a string, leaving only the plain text content.
 *
 * @mentions are routing metadata for our system, not part of the actual
 * question sent to the Agent. This prevents confusion when a user writes
 * "@Mentor @Reviewer please check this" — each Agent should only see
 * "please check this", not the @tags.
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

/**
 * Build the prompt text sent to an Agent when a user comment mentions it.
 *
 * Includes: target text (the selected passage), the user's message (with
 * @mentions stripped), and the prior thread of messages anchored to this card.
 */
export function buildAgentPrompt({
  targetText,
  userMessage,
  threadHistory,
}: {
  targetText: string
  userMessage: string
  threadHistory: Array<{ role: 'user' | 'agent'; content: string; agentName?: string }>
}): string {
  const lines: string[] = []
  if (targetText.trim()) {
    lines.push('上下文（正文被批注的片段）:')
    lines.push(targetText.trim())
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

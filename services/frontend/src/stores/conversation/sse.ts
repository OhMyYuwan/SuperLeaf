/**
 * SSE / 事件流相关的纯解析与状态映射工具。
 *
 * - `findEventBoundary` / `parseSseMessage`：把缓冲区里的下一个事件切出来，做
 *   `event:` + `data:` 字段解析，data 是 JSON 时自动反序列化。
 * - `bridgeStatusFromToolEvent`：从 SuperLeaf MCP 工具事件推导 bridge 在
 *   AgentRunStats 上的状态色（connected / recovering / error）。
 * - 其他都是把 `unknown` 安全收窄成具体形态的小工具。
 */

import type { AgentRunStats } from './types'

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function findEventBoundary(buf: string): { start: number; end: number } | null {
  const crlf = buf.indexOf('\r\n\r\n')
  const lf = buf.indexOf('\n\n')
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { start: crlf, end: crlf + 4 }
  }
  if (lf !== -1) {
    return { start: lf, end: lf + 2 }
  }
  return null
}

export function parseSseMessage(chunk: string): { event: string; data: unknown } | null {
  let eventName = 'message'
  const dataLines: string[] = []
  const normalized = chunk.replace(/\r\n/g, '\n')
  for (const line of normalized.split('\n')) {
    if (!line) continue
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    data = raw
  }
  return { event: eventName, data }
}

export function bridgeStatusFromToolEvent(
  name: string,
  failed: boolean,
  data: { tool_kind?: string; error?: unknown },
): { status: NonNullable<AgentRunStats['bridgeStatus']>; error?: string } | null {
  if (name === 'superleaf_mcp_context' && !failed) {
    return { status: 'connected' }
  }
  if (name === 'superleaf_mcp_poll' || name === 'superleaf_mcp_refresh') {
    return {
      status: 'recovering',
      error: formatEventError(data.error) || 'SuperLeaf MCP 正在重连',
    }
  }
  if (data.tool_kind === 'superleaf_mcp' && failed) {
    return {
      status: 'error',
      error: formatEventError(data.error) || 'SuperLeaf MCP 工具调用失败',
    }
  }
  return null
}

export function formatEventError(value: unknown): string {
  if (!value) return ''
  if (value instanceof Error) return value.message
  return String(value)
}

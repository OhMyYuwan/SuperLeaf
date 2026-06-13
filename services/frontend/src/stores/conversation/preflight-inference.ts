/**
 * Nanobot 浏览器分支：在把用户消息送给本机 Nanobot 之前，根据自然语言预判
 * 该先调哪些 SuperLeaf 只读工具（list_docs / read_doc / grep / outline）。
 *
 * 拣选优先级：
 * 1. 文本里直接出现 `project_xxx` 工具名 → 按出现顺序
 * 2. 文本里有「调用 / 使用 / 通过 工具」之类显式提示 → 按自然语言推断
 * 3. 自然语言推断（搜索/大纲/列出/读取）
 *
 * 真正发起调用的是 `executeNanobotBrowserToolRequest`，这里只构造工具调用的
 * 描述（NanobotToolCall）。
 */

import type { NanobotToolCall } from '../../services/backendApi'
import { inferFormatFilter, inferGrepPattern } from './grep-inference'

export const PREFLIGHT_READ_TOOL_NAMES = new Set([
  'project_list_docs',
  'project_read_doc',
  'project_grep',
  'project_outline',
])

export interface BrowserToolPreparedContext {
  document_id: string
  range_start: number
  range_end: number
}

export interface BrowserToolExecutionContext extends BrowserToolPreparedContext {
  inputs: Record<string, unknown>
  superleaf_context?: Record<string, unknown>
}

export function inferBrowserNanobotPreflightToolCalls(
  content: string,
  prepared: BrowserToolPreparedContext,
): NanobotToolCall[] {
  const text = content.trim()
  if (!text) return []
  const explicitToolNames = orderedExplicitReadToolNames(text)
  const naturalToolNames = inferNaturalReadToolNames(text)
  const requested = explicitToolNames.length > 0
    ? explicitToolNames
    : naturalToolNames.length > 0 || hasExplicitSuperLeafToolCue(text)
      ? naturalToolNames
      : []
  if (requested.length === 0) return []
  return requested
    .map((name) => buildBrowserNanobotPreflightToolCall(name, text, prepared))
    .filter((call): call is NanobotToolCall => Boolean(call))
}

function orderedExplicitReadToolNames(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  const pattern = /\bproject_(list_docs|read_doc|grep|outline)\b/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(lower)) !== null) {
    const name = `project_${match[1]}`
    if (PREFLIGHT_READ_TOOL_NAMES.has(name) && !out.includes(name)) {
      out.push(name)
    }
  }
  return out
}

function hasExplicitSuperLeafToolCue(text: string): boolean {
  return (
    /SuperLeaf\s*(?:工具|tool)/iu.test(text) ||
    /(?:调用|使用|执行|先用|通过).{0,12}(?:工具|tool)/iu.test(text) ||
    /(?:工具|tool).{0,12}(?:读取|搜索|查找|列出|生成大纲|大纲)/iu.test(text)
  )
}

function inferNaturalReadToolNames(text: string): string[] {
  if (/(?:搜索|查找|检索|grep|find)/iu.test(text)) return ['project_grep']
  if (/(?:大纲|outline|章节|目录|结构)/iu.test(text)) return ['project_outline']
  if (/(?:列出|列表|所有文档|项目文档|文档清单)/iu.test(text)) return ['project_list_docs']
  if (/(?:读取|读一下|查看|打开|当前(?:编辑区)?文档|active document|current document)/iu.test(text)) {
    return ['project_read_doc']
  }
  return []
}

function buildBrowserNanobotPreflightToolCall(
  name: string,
  text: string,
  prepared: BrowserToolPreparedContext,
): NanobotToolCall | null {
  let args: Record<string, unknown>
  if (name === 'project_list_docs') {
    args = {}
  } else if (name === 'project_read_doc') {
    args = { doc_id: prepared.document_id }
    if (shouldReadSelection(text, prepared)) {
      args.range_start = prepared.range_start
      args.range_end = prepared.range_end
    }
  } else if (name === 'project_outline') {
    args = { doc_id: prepared.document_id }
  } else if (name === 'project_grep') {
    const pattern = inferGrepPattern(text)
    if (!pattern) return null
    args = { pattern, max_results: 30 }
    const format = inferFormatFilter(text)
    if (format) args.format = format
  } else {
    return null
  }
  return {
    id: `preflight_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

function shouldReadSelection(text: string, prepared: BrowserToolPreparedContext): boolean {
  return prepared.range_end > prepared.range_start && /(?:选中|选择|selection|selected)/iu.test(text)
}

/**
 * 浏览器侧工具调用桥接：把后端 `prepare` 出来的工具调用请求路由到 SuperLeaf
 * Local Agent Host（或后端 fallback），并把返回的 events 串接进会话消息流。
 *
 * 三个 transport 各有独立的 conversationApi.executeBrowser*Tool endpoint，但
 * 入参/出参形态完全对称，所以抽出 `executeNanobotBrowserToolRequest` 等同形
 * 函数。失败时根据 signal 区分主动取消（AbortError）和真实错误。
 */

import {
  conversationApi,
  type BrowserNanobotToolResult,
  type NanobotToolCall,
} from '../../services/backendApi'
import {
  bridgeRequestFromToolCall,
  toolCallFromBridgeRequest,
  type BrowserToolBridgeRequest,
} from '../../services/browserToolBridge'
import { normalizeBrowserToolResultForAgent } from '../../services/superleafToolResultEnvelope'
import { handleMessageEvent } from './handle-message-event'
import type { BrowserToolExecutionContext } from './preflight-inference'
import type { ConversationSet } from './types'

export async function executeNanobotToolCall(args: {
  conversationId: string
  runId: string
  prepared: BrowserToolExecutionContext
  toolCall: NanobotToolCall
  signal: AbortSignal
  markActivity: () => void
  set: ConversationSet
}): Promise<BrowserNanobotToolResult> {
  return executeNanobotBrowserToolRequest({
    conversationId: args.conversationId,
    runId: args.runId,
    request: bridgeRequestFromPreparedToolCall(args.toolCall, args.conversationId, args.prepared),
    signal: args.signal,
    markActivity: args.markActivity,
    set: args.set,
  })
}

export async function executeCodexToolCall(args: {
  conversationId: string
  runId: string
  prepared: BrowserToolExecutionContext
  toolCall: NanobotToolCall
  signal: AbortSignal
  markActivity: () => void
  set: ConversationSet
}): Promise<BrowserNanobotToolResult> {
  return executeCodexBrowserToolRequest({
    conversationId: args.conversationId,
    runId: args.runId,
    request: bridgeRequestFromPreparedToolCall(args.toolCall, args.conversationId, args.prepared),
    signal: args.signal,
    markActivity: args.markActivity,
    set: args.set,
  })
}

export function bridgeRequestFromPreparedToolCall(
  toolCall: NanobotToolCall,
  conversationId: string,
  prepared: BrowserToolExecutionContext,
): BrowserToolBridgeRequest {
  return bridgeRequestFromToolCall(toolCall, {
    projectId: prepared.superleaf_context
      ? String(prepared.superleaf_context.project_id ?? '')
      : '',
    conversationId: prepared.superleaf_context
      ? String(prepared.superleaf_context.conversation_id ?? conversationId)
      : conversationId,
    documentId: prepared.document_id,
    rangeStart: prepared.range_start,
    rangeEnd: prepared.range_end,
    inputs: prepared.inputs,
  })
}

export async function executeNanobotBrowserToolRequest(args: {
  conversationId: string
  runId: string
  request: BrowserToolBridgeRequest
  signal: AbortSignal
  markActivity: () => void
  set: ConversationSet
}): Promise<BrowserNanobotToolResult> {
  try {
    const result = normalizeBrowserToolResultForAgent(await conversationApi.executeBrowserNanobotTool(args.conversationId, {
      run_id: args.runId,
      document_id: args.request.document_id,
      range_start: args.request.range_start,
      range_end: args.request.range_end,
      inputs: bridgeInputsWithAgent(args.request),
      tool_call: toolCallFromBridgeRequest(args.request),
    }, { signal: args.signal }))
    args.markActivity()
    for (const evt of result.events) {
      handleMessageEvent(args.set, args.conversationId, evt)
    }
    return result
  } catch (err) {
    if (args.signal.aborted) {
      throw new DOMException('Browser tool request aborted', 'AbortError')
    }
    throw err
  }
}

export async function executeCodexBrowserToolRequest(args: {
  conversationId: string
  runId: string
  request: BrowserToolBridgeRequest
  signal: AbortSignal
  markActivity: () => void
  set: ConversationSet
}): Promise<BrowserNanobotToolResult> {
  try {
    const result = normalizeBrowserToolResultForAgent(await conversationApi.executeBrowserCodexTool(args.conversationId, {
      run_id: args.runId,
      document_id: args.request.document_id,
      range_start: args.request.range_start,
      range_end: args.request.range_end,
      inputs: bridgeInputsWithAgent(args.request),
      tool_call: toolCallFromBridgeRequest(args.request),
    }, { signal: args.signal }))
    args.markActivity()
    for (const evt of result.events) {
      handleMessageEvent(args.set, args.conversationId, evt)
    }
    return result
  } catch (err) {
    if (args.signal.aborted) {
      throw new DOMException('Browser tool request aborted', 'AbortError')
    }
    throw err
  }
}

export async function executeClaudeBrowserToolRequest(args: {
  conversationId: string
  runId: string
  request: BrowserToolBridgeRequest
  signal: AbortSignal
  markActivity: () => void
  set: ConversationSet
}): Promise<BrowserNanobotToolResult> {
  try {
    const result = normalizeBrowserToolResultForAgent(await conversationApi.executeBrowserClaudeTool(args.conversationId, {
      run_id: args.runId,
      document_id: args.request.document_id,
      range_start: args.request.range_start,
      range_end: args.request.range_end,
      inputs: bridgeInputsWithAgent(args.request),
      tool_call: toolCallFromBridgeRequest(args.request),
    }, { signal: args.signal }))
    args.markActivity()
    for (const evt of result.events) {
      handleMessageEvent(args.set, args.conversationId, evt)
    }
    return result
  } catch (err) {
    if (args.signal.aborted) {
      throw new DOMException('Browser tool request aborted', 'AbortError')
    }
    throw err
  }
}

function bridgeInputsWithAgent(request: BrowserToolBridgeRequest): Record<string, unknown> {
  if (!request.agent_name) return request.inputs
  return { ...request.inputs, agent_name: request.agent_name }
}

export function claudeToolMode(prepared: { claude_settings?: { tool_mode?: unknown } }): 'mcp-first' | 'browser-preflight' | 'marker-only' {
  const value = String(prepared.claude_settings?.tool_mode || 'mcp-first')
  return value === 'browser-preflight' || value === 'marker-only' ? value : 'mcp-first'
}

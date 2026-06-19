/**
 * 把一条用户消息送给浏览器侧 Nanobot（OpenAI tools 协议），处理多轮工具调用，
 * 直到模型给出最终答复，再把结果落库为正式 agent 消息。
 *
 * 对话流：
 * 1. `prepareBrowserNanobot` 后端打包 prompt + tools，给出 endpoint / model
 * 2. 客户端识别用户输入里的 SuperLeaf 只读工具意图（preflight），先跑一遍
 * 3. 进 `streamBrowserNanobotTurn` 循环：模型可能要工具，本地执行后再喂回
 * 4. 工具调用清空时，落 `finishBrowserNanobot` 把整段消息持久化
 */

import {
  conversationApi,
  type MessageSend,
  type NanobotChatMessage,
  type Provider,
} from '../../services/backendApi'
import {
  readBrowserNanobotApiKey,
  streamBrowserNanobotTurn,
} from '../../services/nanobotBrowserClient'
import { toolGuideModeForNanobot } from '../../services/agentToolGuidePolicy'
import { handleMessageEvent } from './handle-message-event'
import { inferBrowserNanobotPreflightToolCalls } from './preflight-inference'
import { executeNanobotToolCall } from './tool-execution'
import type { ConversationSet } from './types'

export function browserNanobotTurnEndpoint(prepared: { endpoint: string; bridge_endpoint?: string }): string {
  return prepared.bridge_endpoint || prepared.endpoint
}

export async function sendViaBrowserNanobot(args: {
  conversationId: string
  body: MessageSend
  provider: Provider
  signal: AbortSignal
  markActivity: () => void
  set: ConversationSet
}): Promise<void> {
  const prepared = await conversationApi.prepareBrowserNanobot(args.conversationId, args.body)
  args.markActivity()
  handleMessageEvent(args.set, args.conversationId, {
    event: 'ylw.msg.user',
    data: prepared.user_message,
  })

  const apiKey = readBrowserNanobotApiKey(args.provider.id)
  const messages: NanobotChatMessage[] = prepared.messages.slice()
  const finalParts: string[] = []
  const preflightToolCalls = inferBrowserNanobotPreflightToolCalls(args.body.content, prepared)

  if (preflightToolCalls.length > 0) {
    messages.push({
      role: 'system',
      content: [
        'SuperLeaf has already executed the read-only project tool request below before the Nanobot model turn.',
        'Use the tool result. Do not say the API channel has no SuperLeaf tools.',
        'If more project context is needed, request another available SuperLeaf tool.',
      ].join(' '),
    })
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: preflightToolCalls,
    })
    for (const toolCall of preflightToolCalls) {
      const result = await executeNanobotToolCall({
        conversationId: args.conversationId,
        runId: prepared.run_id,
        prepared,
        toolCall,
        signal: args.signal,
        markActivity: args.markActivity,
        set: args.set,
      })
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_call_id,
        content: result.content,
      })
    }
  }

  while (true) {
    const turn = await streamBrowserNanobotTurn({
      endpoint: browserNanobotTurnEndpoint(prepared),
      apiKey,
      model: prepared.model,
      sessionId: prepared.run_id,
      messages,
      tools: prepared.tools,
      toolGuideMode: toolGuideModeForNanobot(),
      signal: args.signal,
      onActivity: args.markActivity,
      onDelta: (delta) => {
        finalParts.push(delta)
        handleMessageEvent(args.set, args.conversationId, {
          event: 'ylw.msg.delta',
          data: { delta },
        })
      },
    })

    if (turn.toolCalls.length === 0) {
      const finished = await conversationApi.finishBrowserNanobot(args.conversationId, {
        run_id: prepared.run_id,
        content: finalParts.join('') || turn.content,
      })
      handleMessageEvent(args.set, args.conversationId, {
        event: 'ylw.msg.finished',
        data: finished,
      })
      return
    }

    messages.push({
      role: 'assistant',
      content: turn.content || null,
      tool_calls: turn.toolCalls,
    })

    for (const toolCall of turn.toolCalls) {
      const result = await executeNanobotToolCall({
        conversationId: args.conversationId,
        runId: prepared.run_id,
        prepared,
        toolCall,
        signal: args.signal,
        markActivity: args.markActivity,
        set: args.set,
      })
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_call_id,
        content: result.content,
      })
    }
  }
}

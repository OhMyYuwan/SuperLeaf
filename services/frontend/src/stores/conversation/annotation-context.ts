/**
 * resolveSuggestionAnnotationContext —— SSE `ylw.msg.suggestion_created` 事件
 * 转批注时，需要决定这条建议挂在哪个 conversation_id / workflow_id / agent
 * 名字下。
 *
 * 直接从 useConversationStore 读当前对话信息。该模块和 conversationStore.ts
 * 之间存在 ESM 循环引用，但因为这里只在函数体内用 `getState()`（不是模块顶层
 * 引用），运行时绑定一定已经就绪。
 */

import type { Conversation } from '../../services/backendApi'
import { useWorkflowStore } from '../workflowStore'

/**
 * 主入口的 wrapper 会把 `useConversationStore.getState().conversations[id]`
 * 注入进来。这里写成参数可避免循环 import 时的 binding 顺序困扰，也方便测试
 * 直接以 plain object 喂入。
 */
export function resolveSuggestionAnnotationContextFromConversation(
  conversation: Conversation | undefined,
  conversationId: string,
  data: Record<string, unknown> = {},
): { sourceConversationId: string; workflowId: string; agentName: string } {
  const workflowIdFromEvent = String(data.workflow_id ?? '').trim()
  const workflowId = workflowIdFromEvent || conversation?.workflow_id || conversationId
  const workflow = useWorkflowStore.getState().workflows.find((item) => item.id === workflowId)
  const agentNameFromEvent = String(data.agent_name ?? '').trim()
  return {
    sourceConversationId: conversationId,
    workflowId,
    agentName: agentNameFromEvent || workflow?.name || 'Agent',
  }
}

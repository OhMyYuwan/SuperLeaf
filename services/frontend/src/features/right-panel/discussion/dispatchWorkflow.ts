/**
 * dispatchWorkflowToConversation — 在聊天面板「对话」内带运行一个 Workflow 定义。
 *
 * 走的是和 Agent 消息一样的注入通道：成功时把 summary 作为合成 agent 消息塞回对话，
 * 失败时把错误也写成消息体。这样用户不用离开 discussion 视图就能看到 workflow 跑没跑通。
 */

import type { Selection } from '../../../types/editor'
import {
  resolveAttachedFiles,
  type WorkflowCandidate,
} from '../../../services/mentions'
import { useConversationStore } from '../../../stores/conversationStore'
import { useWorkflowStore } from '../../../stores/workflowStore'

export async function dispatchWorkflowToConversation({
  workflow,
  conversationId,
  documentId,
  selection,
  attachedFiles,
  query,
  executeDefinition,
  injectMessage,
}: {
  workflow: WorkflowCandidate
  conversationId: string
  documentId: string
  selection: Selection | null
  attachedFiles: Awaited<ReturnType<typeof resolveAttachedFiles>>
  query: string
  executeDefinition: ReturnType<typeof useWorkflowStore.getState>['executeDefinition']
  injectMessage: ReturnType<typeof useConversationStore.getState>['injectMessage']
}): Promise<void> {
  const rangeStart = selection && selection.to > selection.from ? selection.from : 0
  const rangeEnd = selection && selection.to > selection.from ? selection.to : 0
  const targetText = selection?.text ?? ''

  await executeDefinition(
    workflow.id,
    {
      document_id: documentId,
      range_start: rangeStart,
      range_end: rangeEnd,
      inputs: {
        target_text: targetText,
        user_message: query,
        text: targetText,
        attached_files: attachedFiles,
      },
      query,
    },
    {
      autoIngestToAnnotations: false,
      onCompleted: async (summary) => {
        const body = summary && summary.trim() ? summary.trim() : `（${workflow.name} 已运行完毕，未产出摘要文本）`
        await injectMessage(conversationId, {
          role: 'agent',
          content: `【Workflow · ${workflow.name}】\n${body}`,
          range_start: selection && selection.to > selection.from ? selection.from : undefined,
          range_end: selection && selection.to > selection.from ? selection.to : undefined,
        })
      },
      onFailed: async (err) => {
        await injectMessage(conversationId, {
          role: 'agent',
          content: `【Workflow · ${workflow.name}】运行失败`,
          error: err,
        })
      },
    },
  )
}

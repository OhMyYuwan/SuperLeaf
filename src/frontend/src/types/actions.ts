/**
 * Layer 7: User Actions & Interactions
 *
 * 定义用户可以执行的所有操作，以及这些操作如何触发数据流
 */

export type UserActionType =
  | 'edit'
  | 'select'
  | 'trigger-workflow'
  | 'accept-suggestion'
  | 'reject-suggestion'
  | 'send-message'
  | 'resolve-annotation'
  | 'create-agent'
  | 'modify-agent'
  | 'create-workflow'
  | 'modify-workflow'

export interface UserAction {
  type: UserActionType
  timestamp: Date
  context: Record<string, any>
}

// 用户触发 Workflow
export interface TriggerWorkflowAction {
  type: 'trigger-workflow'
  workflowId: string
  targetRange?: { from: number; to: number }  // 如果是 selection 触发
  userInstruction?: string  // 用户的额外指令
}

// 用户接受建议
export interface AcceptSuggestionAction {
  type: 'accept-suggestion'
  suggestionId: string
  // 接受后会修改文档，产生新版本
}

// 用户拒绝建议
export interface RejectSuggestionAction {
  type: 'reject-suggestion'
  suggestionId: string
  reason?: string  // 可选的拒绝理由
}

// 用户发送消息（参与讨论）
export interface SendMessageAction {
  type: 'send-message'
  discussionId: string
  content: string
  replyTo?: string  // 回复某条消息
}

// 用户解决批注
export interface ResolveAnnotationAction {
  type: 'resolve-annotation'
  annotationId: string
  resolution?: string  // 如何解决的
}

/**
 * Layer 4: Team Communication & Collaboration
 *
 * Agent Team 的交流机制：
 * 1. Agent 之间通过结构化数据交流（不是自由文本）
 * 2. 用户可以作为 orchestrator（触发 workflow）或 collaborator（参与讨论）
 * 3. 讨论可以锚定到文档的特定位置
 */

export type ParticipantType = 'user' | 'agent'
export type CollaborationMode = 'sequential' | 'parallel' | 'debate' | 'consensus'
export type ConflictResolution = 'user-decide' | 'vote' | 'priority' | 'merge'

export interface TeamDiscussion {
  id: string
  documentId: string
  targetRange?: { from: number; to: number }  // 可选，可以是全局讨论
  participants: Participant[]
  messages: Message[]
  status: 'active' | 'resolved' | 'archived'
  createdAt: Date
  resolvedAt?: Date
}

export interface Participant {
  id: string
  type: ParticipantType
  name: string
  role?: string
  avatar?: string
}

export interface Message {
  id: string
  discussionId: string
  senderId: string  // user id 或 agent id
  senderType: ParticipantType
  content: string
  timestamp: Date

  // 如果是 Agent 发的，可能附带结构化数据
  attachments?: {
    annotations?: string[]  // annotation ids
    suggestions?: string[]  // suggestion ids
    risks?: string[]  // risk ids
  }

  // 引用关系
  replyTo?: string  // message id
  references?: string[]  // 引用的其他消息或批注
}

// Agent 之间的协作模式
export interface AgentCollaboration {
  mode: CollaborationMode

  // sequential: A → B → C，后面的 Agent 能看到前面的输出
  // parallel: A, B, C 同时执行，互不干扰
  // debate: A 和 B 对同一段文本给出不同意见，C 作为仲裁
  // consensus: 所有 Agent 必须达成一致才输出

  conflictResolution: ConflictResolution

  // 如果是 priority 模式，定义优先级
  priority?: string[]  // agent ids in priority order
}

// 用户参与模式
export interface UserParticipation {
  mode: 'observer' | 'reviewer' | 'collaborator'

  // observer: 只看 Agent 的输出，不参与
  // reviewer: 可以 accept/reject Agent 的建议
  // collaborator: 可以直接在讨论区和 Agent 对话

  permissions: {
    canTriggerWorkflow: boolean
    canAcceptSuggestions: boolean
    canRejectSuggestions: boolean
    canReplyToAgents: boolean
    canModifyAgentConfig: boolean
    canModifyWorkflow: boolean
  }
}

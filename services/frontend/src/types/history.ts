/**
 * Layer 5: History & Versioning
 *
 * 记录所有操作的历史，支持：
 * 1. 文档版本回溯
 * 2. Agent 操作审计
 * 3. 用户决策历史（accept/reject）
 */

export type OperationType =
  | 'user-edit'
  | 'agent-annotate'
  | 'agent-suggest'
  | 'user-accept-suggestion'
  | 'user-reject-suggestion'
  | 'workflow-run'
  | 'user-resolve-annotation'

export interface DocumentHistory {
  documentId: string
  versions: DocumentVersion[]
  operations: Operation[]
}

export interface DocumentVersion {
  version: number
  content: string
  timestamp: Date
  author: 'user' | string  // 'user' 或 agent id
  changeType: 'edit' | 'accept-suggestion' | 'reject-suggestion' | 'revert'
  diff?: Diff
  message?: string  // 版本说明
}

export interface Operation {
  id: string
  type: OperationType
  timestamp: Date
  actor: string  // user id 或 agent id
  actorType: 'user' | 'agent'
  targetRange: { from: number; to: number }
  before?: string
  after?: string
  metadata: Record<string, any>
}

export interface Diff {
  additions: Array<{ range: { from: number; to: number }; text: string }>
  deletions: Array<{ range: { from: number; to: number }; text: string }>
}

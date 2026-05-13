/**
 * Layer 6: UI Presentation
 *
 * 将底层数据转换为 UI 可呈现的视图模型：
 * 1. 编辑器装饰（下划线、高亮、边栏标记）
 * 2. 批注面板的分组和过滤
 * 3. 讨论区的消息流
 */

export type DecorationType = 'annotation' | 'suggestion' | 'risk' | 'highlight' | 'selection'
export type SeverityLevel = 'low' | 'medium' | 'high' | 'critical'

import type { Agent } from './agent'
import type { TeamDiscussion, Message, Participant } from './collaboration'

// 编辑器里的装饰（用于在文本上标记批注、建议、风险）
export interface EditorDecoration {
  id: string
  range: { from: number; to: number }
  type: DecorationType
  severity?: SeverityLevel
  color?: string
  icon?: string
  tooltip?: string
  onClick?: () => void

  // 关联的数据 ID
  annotationId?: string
  suggestionId?: string
  riskId?: string
}

// 批注面板的视图模型
export interface AnnotationPanelView {
  groupBy: 'agent' | 'severity' | 'position' | 'type' | 'none'
  filters: {
    agents?: string[]
    severities?: SeverityLevel[]
    types?: string[]
    resolved?: boolean
  }
  sort: 'position' | 'time' | 'severity'
  items: AnnotationPanelItem[]
}

export interface AnnotationPanelItem {
  id: string
  type: 'annotation' | 'suggestion' | 'risk'
  agent: {
    id: string
    name: string
    color: string
  }
  content: string
  targetRange: { from: number; to: number }
  targetText: string
  severity?: SeverityLevel
  timestamp: Date
  resolved: boolean

  // 可用操作
  actions: AnnotationAction[]
}

export type AnnotationAction =
  | { type: 'accept'; label: string }
  | { type: 'reject'; label: string }
  | { type: 'reply'; label: string }
  | { type: 'resolve'; label: string }
  | { type: 'jump-to'; label: string }

// 讨论区的视图模型
export interface DiscussionPanelView {
  activeDiscussion?: string  // discussion id
  discussions: TeamDiscussion[]
  recentMessages: Message[]
  unreadCount: number
  participants: Participant[]
}

// Agent 团队面板的视图模型
export interface AgentTeamPanelView {
  agents: Agent[]
  activeAgents: string[]  // 当前激活的 agent ids
  statistics: {
    agentId: string
    annotationCount: number
    suggestionCount: number
    acceptRate: number  // 建议被接受的比例
  }[]
}

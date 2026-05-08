/**
 * Layer 3: Workflow & Execution
 *
 * Workflow 是 Agent 的编排引擎：
 * 1. 定义 Agent 的执行顺序和依赖关系
 * 2. 控制数据在 Agent 之间的流动
 * 3. 处理条件分支和合并逻辑
 */

export type NodeType = 'input' | 'agent' | 'condition' | 'merge' | 'output' | 'user-review'
export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'skipped'

import type { AgentOutput } from './agent'

export interface Workflow {
  id: string
  name: string
  description: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  trigger: WorkflowTrigger
  metadata: {
    created: Date
    modified: Date
    author: string
    version: number
  }
}

export interface WorkflowNode {
  id: string
  type: NodeType
  label: string
  position?: { x: number; y: number }  // 用于可视化编辑器

  // 节点特定配置
  config: NodeConfig
}

export type NodeConfig =
  | InputNodeConfig
  | AgentNodeConfig
  | ConditionNodeConfig
  | MergeNodeConfig
  | OutputNodeConfig
  | UserReviewNodeConfig

export interface InputNodeConfig {
  type: 'input'
  source: 'selection' | 'paragraph' | 'section' | 'document'
}

export interface AgentNodeConfig {
  type: 'agent'
  agentId: string
  // Agent 是否能看到前面节点的输出
  includeUpstreamOutputs: boolean
}

export interface ConditionNodeConfig {
  type: 'condition'
  // 条件表达式
  condition: {
    field: string  // 'confidence' | 'severity' | 'annotationCount' | 'riskCount'
    operator: '>' | '<' | '==' | '!=' | '>=' | '<=' | 'contains'
    value: any
  }
  // 两个出口：true 分支和 false 分支
  trueBranch: string  // node id
  falseBranch: string
}

export interface MergeNodeConfig {
  type: 'merge'
  // 合并策略
  strategy: 'concat' | 'deduplicate' | 'vote' | 'priority'
  // 如果是 priority 策略，定义优先级
  priority?: string[]  // agent ids in priority order
}

export interface OutputNodeConfig {
  type: 'output'
  // 输出到哪里
  destination: 'annotation-panel' | 'discussion' | 'document'
}

export interface UserReviewNodeConfig {
  type: 'user-review'
  // 暂停执行，等待用户审核
  prompt: string  // 提示用户做什么
  actions: ('approve' | 'reject' | 'modify')[]
}

export interface WorkflowEdge {
  id: string
  from: string  // source node id
  to: string    // target node id
  label?: string  // 用于条件边的标签
}

export interface WorkflowTrigger {
  type: 'manual' | 'auto-on-save' | 'auto-on-selection' | 'scheduled'
  config?: {
    // 如果是 auto-on-selection，定义触发条件
    minSelectionLength?: number
    debounceMs?: number

    // 如果是 scheduled
    cron?: string
  }
}

// Workflow 执行实例
export interface WorkflowExecution {
  id: string
  workflowId: string
  documentId: string
  targetRange: { from: number; to: number }
  status: ExecutionStatus

  startTime: Date
  endTime?: Date

  // 执行轨迹（用于调试和可视化）
  trace: ExecutionStep[]

  // 最终产出
  outputs: AgentOutput[]

  // 如果失败，记录错误
  error?: {
    nodeId: string
    message: string
    stack?: string
  }
}

export interface ExecutionStep {
  nodeId: string
  agentId?: string
  startTime: Date
  endTime?: Date
  status: ExecutionStatus
  input: any
  output: any
  error?: string
}

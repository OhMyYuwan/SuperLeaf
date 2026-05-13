/**
 * Layer 2: Agent Model
 *
 * Agent 是执行单元，定义了：
 * 1. 输入契约：从 Document 的哪个范围读取什么数据
 * 2. 输出契约：产出什么类型的结果（批注/建议/风险）
 * 3. 权限模型：只读 / 建议 / 直接修改
 */

export type AgentRole = 'reviewer' | 'polisher' | 'synthesizer' | 'fact-checker' | 'custom'
export type InputScope = 'selection' | 'paragraph' | 'section' | 'document'
export type OutputType = 'annotation' | 'suggestion' | 'rewrite' | 'risk'

export interface Agent {
  id: string
  name: string
  role: AgentRole
  description: string

  // Agent 的能力定义
  capabilities: {
    inputScope: InputScope  // 从哪个范围读取
    outputType: OutputType[]  // 可以产出哪些类型
    needsContext: boolean  // 是否需要上下文
    contextWindow: number  // 需要多少上下文（字符数）
  }

  // Agent 的配置
  config: {
    model: string  // 'claude-opus-4-7' | 'claude-sonnet-4-6'
    temperature: number
    systemPrompt: string
    fewShotExamples?: Example[]
  }

  // Agent 的权限
  permissions: {
    canRead: boolean
    canAnnotate: boolean
    canSuggest: boolean
    canModify: boolean  // 是否可以直接修改文档（危险）
  }

  // UI 配置
  ui: {
    color: string  // 用于在 UI 中区分不同 Agent
    icon?: string
  }
}

export interface Example {
  input: string
  output: string
}

// Agent 的输入（由 Workflow 引擎构造）
export interface AgentInput {
  documentId: string
  targetRange: { from: number; to: number }
  targetText: string
  context: {
    before: string
    after: string
    sectionTitle?: string
    fullDocument?: string
  }

  // 其他 Agent 的输出（用于协作）
  previousAnnotations?: Annotation[]
  previousSuggestions?: Suggestion[]

  // 用户的额外指令
  userInstruction?: string
}

// Agent 的输出
export interface AgentOutput {
  agentId: string
  timestamp: Date
  annotations: Annotation[]
  suggestions: Suggestion[]
  risks: Risk[]

  // 元数据
  metadata: {
    tokensUsed: number
    latency: number
    confidence: number  // 0-1，Agent 对自己输出的信心
  }
}

// 批注：Agent 对文本的评论
export interface Annotation {
  id: string
  agentId: string
  targetRange: { from: number; to: number }
  targetText: string  // 被批注的原文（快照）
  content: string  // 批注内容
  type: 'comment' | 'question' | 'praise' | 'warning'
  severity?: 'low' | 'medium' | 'high'
  tags: string[]
  resolved: boolean
  createdAt: Date
}

// 建议：Agent 建议的修改
export interface Suggestion {
  id: string
  agentId: string
  targetRange: { from: number; to: number }
  original: string  // 原文
  proposed: string  // 建议的修改
  reason: string  // 为什么要改
  confidence: number  // 0-1
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  createdAt: Date
  resolvedAt?: Date
}

// 风险：Agent 识别的潜在问题
export interface Risk {
  id: string
  agentId: string
  targetRange: { from: number; to: number }
  riskType: 'logic' | 'citation' | 'clarity' | 'style' | 'factual' | 'consistency'
  severity: 'low' | 'medium' | 'high' | 'critical'
  description: string
  mitigation?: string  // 如何缓解
  createdAt: Date
}

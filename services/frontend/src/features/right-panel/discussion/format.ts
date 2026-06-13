/**
 * 讨论面板用到的纯格式化函数：时间、会话/agent ID、bridge 状态、approval 方法/状态。
 * 全部是无副作用的小工具，方便在子组件之间共享。
 */

import type { AgentRunStats, LocalAgentApprovalEntry } from '../../../stores/conversationStore'
import type { CachedWorkflow } from '../../../services/backendApi'

export function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString()
  return d.toLocaleDateString()
}

export function shortAgentId(id: string): string {
  return id.trim().slice(0, 5) || '-----'
}

export function formatAgentDisplayName(
  agent: Pick<CachedWorkflow, 'id' | 'provider_id' | 'name'>,
  providerNamesById: ReadonlyMap<string, string>,
): string {
  const providerName = providerNamesById.get(agent.provider_id)?.trim()
  return `${agent.name} (${providerName || shortAgentId(agent.id)})`
}

export function formatShortSessionId(value?: string): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.length <= 12) return raw
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`
}

export function formatSessionRuntime(runtime?: AgentRunStats['sessionRuntime']): string {
  if (runtime === 'claude-local') return 'Claude 会话'
  if (runtime === 'codex-local') return 'Codex 会话'
  return 'Agent 会话'
}

export function formatBridgeStatus(status?: AgentRunStats['bridgeStatus']): string {
  if (status === 'connected') return 'MCP 已连接'
  if (status === 'recovering') return 'MCP 重连中'
  if (status === 'error') return 'MCP 错误'
  return ''
}

export function formatApprovalMethod(approval: LocalAgentApprovalEntry): string {
  if (approval.tool_name) return approval.tool_name
  if (approval.method.includes('elicitation')) return 'mcp'
  if (approval.method.includes('permissions')) return 'permissions'
  if (approval.method.includes('fileChange')) return 'file'
  if (approval.method.includes('commandExecution')) return 'command'
  return approval.method || 'approval'
}

export function localApprovalStatusLabel(status: LocalAgentApprovalEntry['status']): string {
  if (status === 'accepted') return '已允许'
  if (status === 'rejected') return '已拒绝'
  if (status === 'error') return '提交失败'
  return '等待确认'
}

/**
 * 把对话 → workflow → provider 的查找链集中在这里。
 *
 * 几个 sendVia* 入口都需要根据 conversationId 找到对应浏览器侧的 provider
 * （Nanobot / Codex Local / Claude Local），逻辑高度对称：从对话取 workflow_id
 * → 从 workflowStore 反查 provider_id → 从 settingsStore 拿 provider 实体并
 * 校验 kind / transport。
 *
 * `providerIdFromWorkflowId` 处理一个历史兼容情况：旧 workflow_id 形如
 * `<provider_id>:<external_id>`，对应 cached workflow 还没建好时直接拆字段。
 */

import type { Provider } from '../../services/backendApi'
import { useSettingsStore } from '../settingsStore'
import { useWorkflowStore } from '../workflowStore'
import type { ConversationGet } from './types'

export function providerIdFromWorkflowId(workflowId: string): string {
  const idx = workflowId.indexOf(':')
  return idx > 0 ? workflowId.slice(0, idx) : ''
}

export function findBrowserNanobotProvider(
  conversationId: string,
  get: ConversationGet,
): Provider | null {
  const conv = get().conversations[conversationId]
  if (!conv) return null
  const workflows = useWorkflowStore.getState().workflows
  const workflow = workflows.find((item) => item.id === conv.workflow_id)
  const providerId = workflow?.provider_id ?? providerIdFromWorkflowId(conv.workflow_id)
  if (!providerId) return null
  const provider = useSettingsStore.getState().providers.find((item) => item.id === providerId)
  if (!provider || provider.kind !== 'nanobot') return null
  return provider.meta?.transport === 'browser' ? provider : null
}

export function findBrowserCodexProvider(
  conversationId: string,
  get: ConversationGet,
): Provider | null {
  const conv = get().conversations[conversationId]
  if (!conv) return null
  const workflows = useWorkflowStore.getState().workflows
  const workflow = workflows.find((item) => item.id === conv.workflow_id)
  const providerId = workflow?.provider_id ?? providerIdFromWorkflowId(conv.workflow_id)
  if (!providerId) return null
  const provider = useSettingsStore.getState().providers.find((item) => item.id === providerId)
  return provider?.kind === 'codex-local' ? provider : null
}

export function findBrowserClaudeProvider(
  conversationId: string,
  get: ConversationGet,
): Provider | null {
  const conv = get().conversations[conversationId]
  if (!conv) return null
  const workflows = useWorkflowStore.getState().workflows
  const workflow = workflows.find((item) => item.id === conv.workflow_id)
  const providerId = workflow?.provider_id ?? providerIdFromWorkflowId(conv.workflow_id)
  if (!providerId) return null
  const provider = useSettingsStore.getState().providers.find((item) => item.id === providerId)
  return provider?.kind === 'claude-local' ? provider : null
}

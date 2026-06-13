/**
 * Provider（Agent 供应商）相关 API。
 */

import { http } from './client'

export interface Provider {
  id: string
  name: string
  kind: 'dify-local' | 'dify-cloud' | 'claude-direct' | 'claude-local' | 'nanobot' | 'native' | 'codex-local'
  endpoint: string
  status: 'unknown' | 'ok' | 'error'
  status_detail: string
  is_active: boolean
  meta: Record<string, unknown>
  created_at: string
  updated_at: string
  has_api_key: boolean
}

export interface ProviderDraft {
  name: string
  kind: Provider['kind']
  endpoint: string
  api_key: string
  activate?: boolean
  transport?: 'backend' | 'browser'
  workspace_path?: string
  codex_model?: string
  codex_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  codex_summary?: 'none' | 'auto' | 'concise' | 'detailed'
  codex_service_tier?: string
  codex_sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  codex_approval_policy?: 'never' | 'untrusted' | 'on-request' | 'on-failure'
  codex_prompt_mode?: 'fast-edit' | 'full-agent'
  codex_tool_mode?: 'mcp-first' | 'browser-preflight' | 'marker-only'
  codex_context_mode?: 'legacy-blocks' | 'lease'
  claude_model?: string
  claude_prompt_mode?: 'fast-edit' | 'full-agent'
  claude_tool_mode?: 'mcp-first' | 'browser-preflight' | 'marker-only'
}

export interface ProviderUpdate {
  name?: string
  endpoint?: string
  api_key?: string
  transport?: 'backend' | 'browser'
  workspace_path?: string
  codex_model?: string
  codex_effort?: ProviderDraft['codex_effort']
  codex_summary?: ProviderDraft['codex_summary']
  codex_service_tier?: string
  codex_sandbox?: ProviderDraft['codex_sandbox']
  codex_approval_policy?: ProviderDraft['codex_approval_policy']
  codex_prompt_mode?: ProviderDraft['codex_prompt_mode']
  codex_tool_mode?: ProviderDraft['codex_tool_mode']
  codex_context_mode?: ProviderDraft['codex_context_mode']
  claude_model?: string
  claude_prompt_mode?: ProviderDraft['claude_prompt_mode']
  claude_tool_mode?: ProviderDraft['claude_tool_mode']
}

export interface ProviderModel {
  id: string
  name: string
  description: string
  model?: string
  hidden?: boolean
  is_default?: boolean
  default_reasoning_effort?: string
  supported_reasoning_efforts?: string[]
  raw?: Record<string, unknown>
  service_tiers?: Array<{ id: string; name: string; description?: string }>
  default_service_tier?: string
}

export const providerApi = {
  list: () => http<Provider[]>('/api/providers'),
  create: (draft: ProviderDraft) =>
    http<Provider>('/api/providers', { method: 'POST', body: JSON.stringify(draft) }),
  update: (id: string, patch: ProviderUpdate) =>
    http<Provider>(`/api/providers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) =>
    http<void>(`/api/providers/${id}`, { method: 'DELETE' }),
  activate: (id: string) =>
    http<Provider>(`/api/providers/${id}/activate`, { method: 'POST' }),
  probe: (id: string) =>
    http<Provider>(`/api/providers/${id}/probe`, { method: 'POST' }),
  listModels: (id: string) =>
    http<ProviderModel[]>(`/api/providers/${id}/models`),
  syncBrowserNanobotModels: (
    id: string,
    body: { provider_name?: string; models: ProviderModel[]; local_agent_host_endpoint?: string },
  ) =>
    http<Provider>(`/api/providers/${id}/browser-nanobot-models`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  syncBrowserCodexAgent: (
    id: string,
    body: { health?: Record<string, unknown>; models?: ProviderModel[] },
  ) =>
    http<Provider>(`/api/providers/${id}/browser-codex-agent`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  syncBrowserClaudeAgent: (
    id: string,
    body: { health?: Record<string, unknown> },
  ) =>
    http<Provider>(`/api/providers/${id}/browser-claude-agent`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}

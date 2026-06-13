/**
 * Shared constants and the TeamTab sub-tab union.
 */

import type { McpExecutionPolicy, ProviderDraft } from '../../../services/backendApi'

export type SubTab = 'agents' | 'skills' | 'mcps' | 'workflows'
export type McpCustomTab = 'remote' | 'stdio'

export const DEFAULT_MCP_POLICY: McpExecutionPolicy = {
  remote_enabled: true,
  stdio_enabled: false,
  inline_config_enabled: false,
  remote_private_networks_enabled: false,
  allowed_transports: ['remote'],
}

export const DEFAULT_DIFY_LOCAL_ENDPOINT = 'http://localhost:8080/v1'
export const LOCAL_AGENT_PROVIDER_KINDS = new Set<ProviderDraft['kind']>(['nanobot', 'codex-local', 'claude-local'])

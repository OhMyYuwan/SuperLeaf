/**
 * MCP 访问 token 相关 API。
 */

import { http } from './client'

export interface McpToken {
  id: string
  name: string
  scope: 'read' | 'write'
  token_hint: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
  is_active: boolean
}

export interface McpTokenCreateIn {
  name: string
  scope: 'read' | 'write'
  expires_in_days: number | null
}

export interface McpTokenCreateOut {
  token: McpToken
  plaintext: string
}

export const mcpTokenApi = {
  list: () => http<McpToken[]>('/api/mcp/tokens', { scope: 'global' }),
  create: (draft: McpTokenCreateIn) =>
    http<McpTokenCreateOut>('/api/mcp/tokens', {
      method: 'POST',
      body: JSON.stringify(draft),
      scope: 'global',
    }),
  revoke: (tokenId: string) =>
    http<void>(`/api/mcp/tokens/${encodeURIComponent(tokenId)}`, {
      method: 'DELETE',
      scope: 'global',
    }),
}

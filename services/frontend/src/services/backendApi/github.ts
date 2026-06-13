/**
 * GitHub 账号、OAuth/device 与 import/push 相关 API。
 */

import { http } from './client'

export interface GitHubAccountStatus {
  connected: boolean
  login: string
  name: string
  avatar_url: string
  scope: string
  updated_at: string | null
}

export interface GitHubOAuthStart {
  authorize_url: string
}

export interface GitHubDeviceStart {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export interface GitHubDevicePoll {
  status: 'pending' | 'slow_down' | 'connected' | 'failed' | string
  error: string
  interval: number | null
  account: GitHubAccountStatus | null
}

export interface GitHubImportResult {
  project_id: string
  repo_url: string
  branch: string
  doc_count: number
  file_count: number
  byte_count: number
}

export interface GitHubPushResult {
  project_id: string
  repo_url: string
  branch: string
  commit_sha: string
  pushed: boolean
}

export const githubApi = {
  account: () => http<GitHubAccountStatus>('/api/github/account', { scope: 'global' }),
  startOAuth: () =>
    http<GitHubOAuthStart>('/api/github/oauth/start', { method: 'POST', scope: 'global' }),
  startDevice: (clientId?: string) =>
    http<GitHubDeviceStart>('/api/github/device/start', {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId || null, scope: 'repo' }),
      scope: 'global',
    }),
  pollDevice: (deviceCode: string, clientId?: string) =>
    http<GitHubDevicePoll>('/api/github/device/poll', {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId || null, device_code: deviceCode }),
      scope: 'global',
    }),
  connectToken: (token: string) =>
    http<GitHubAccountStatus>('/api/github/token', {
      method: 'POST',
      body: JSON.stringify({ token }),
      scope: 'global',
    }),
  disconnect: () =>
    http<void>('/api/github/account', { method: 'DELETE', scope: 'global' }),
}

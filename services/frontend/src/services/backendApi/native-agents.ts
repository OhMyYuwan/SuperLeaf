/**
 * 原生 Agent、Skill、MCP server 与 Local Agent Host 相关 API。
 */

import { http, BASE, downloadBackendFile } from './client'

export interface NativeAgentCredential {
  id: string
  user_id: string
  name: string
  base_url: string
  runtime_kind: string
  default_model: string
  status: 'unknown' | 'ok' | 'error' | string
  status_detail: string
  meta: Record<string, unknown>
  created_at: string
  updated_at: string
  has_api_key: boolean
}

export interface NativeAgentCredentialDraft {
  name: string
  base_url: string
  api_key: string
  runtime_kind?: string
  default_model: string
}

export interface NativeAgentCredentialPatch {
  name?: string
  base_url?: string
  api_key?: string
  runtime_kind?: string
  default_model?: string
}

export interface Skill {
  id: string
  owner_user_id: string
  name: string
  public_name: string
  description: string
  content: string
  visibility: 'system' | 'private' | 'public' | string
  source: 'bundled' | 'upload' | string
  project_id: string
  cache_version: number
  cache_updated_at: string | null
  version: number
  tags: string[]
  can_edit: boolean
  used_by_agent_count: number
  created_at: string
  updated_at: string
  published_at: string | null
  release_id?: string | null
  release_version?: string
  release_checksum?: string
  release_install_spec?: string
}

export interface SkillUsage {
  agent_id: string
  agent_name: string
  project_id: string
}

export interface SkillMarketplaceEntry {
  id: string
  name: string
  display_name: string
  version: string
  author_github: string
  description: string
  tags: string[]
  license: string
  path: string
  entry: string
  skill_url: string
  entry_url: string
  readme_url: string
  checksum_sha256: string
  repo_url: string
  source_url: string
  source_ref: string
  skill_name: string
  install_command: string
  installed: boolean
  installed_skill_id: string | null
  installed_version: string
  update_available: boolean
}

export interface SkillMarketplace {
  catalog_url: string
  skills: SkillMarketplaceEntry[]
}

export interface SkillMarketplaceInstallResult {
  skill: Skill
  marketplace_entry: SkillMarketplaceEntry
}

export interface SkillMarketplaceCloneResult {
  skill: Skill
}

export interface SkillDraft {
  name: string
  folder_name?: string
  entry_filename?: string
  description?: string
  content: string
  tags?: string[]
}

export interface SkillRecipeDraft {
  name?: string
  description?: string
  repo_url?: string
  source_url?: string
  source_ref?: string
  skill_name?: string
  install_command?: string
  tags?: string[]
}

export interface SkillPatch {
  name?: string
  description?: string
  content?: string
  tags?: string[]
}

export interface NativeAgent {
  id: string
  project_id: string
  owner_user_id: string
  provider_id: string
  name: string
  description: string
  model: string
  instructions: string
  agent_md: string
  skill_ids: string[]
  workspace_path: string
  setup_status: string
  setup_log: string
  output_contract: 'annotation' | 'plan' | 'workflow' | 'freeform' | string
  runtime_config: Record<string, unknown>
  is_enabled: boolean
  created_at: string
  updated_at: string
}

export interface NativeAgentSkillRecipe {
  source?: string
  marketplace_id?: string
  repo_url: string
  source_url?: string
  source_ref?: string
  skill_name: string
  install_command?: string
}

export interface NativeAgentSkillInstall {
  id: string
  project_id: string
  user_id: string
  agent_id: string
  skill_id: string
  source: string
  marketplace_id: string
  repo_url: string
  source_ref: string
  skill_name: string
  folder_name: string
  install_command: string
  folder_path: string
  manifest: Record<string, unknown>
  status: string
  install_log: string
  created_at: string
  updated_at: string
  installed_at: string | null
}

export interface NativeAgentMcpServer {
  id: string
  name: string
  enabled: boolean
  transport?: string
  endpoint?: string
  command: string
  args: string[]
  env?: Record<string, string>
  allowed_tools?: string[]
}

export interface NativeMcpServerConfig {
  id: string
  user_id: string
  preset_id: string
  source: 'catalog' | 'custom' | string
  name: string
  description: string
  transport: string
  endpoint: string
  command: string
  args: string[]
  env_keys: string[]
  allowed_tools: string[]
  is_enabled: boolean
  status: 'unknown' | 'ok' | 'error' | string
  status_detail: string
  last_probe_at: string | null
  last_probe_status: string
  last_probe_detail: string
  last_golden_at: string | null
  last_golden_status: string
  last_golden_detail: string
  last_tool_count: number
  created_at: string
  updated_at: string
}

export interface NativeMcpServerConfigDraft {
  preset_id?: string
  source?: 'catalog' | 'custom'
  name?: string
  description?: string
  transport?: string
  endpoint?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  allowed_tools?: string[]
  is_enabled?: boolean
}

export interface NativeMcpServerConfigPatch {
  name?: string
  description?: string
  transport?: string
  endpoint?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  allowed_tools?: string[]
  is_enabled?: boolean
}

export interface McpPreset {
  id: string
  name: string
  owner?: string
  qualified_name?: string
  registry?: 'official' | 'external' | string
  official_recommended?: boolean
  description: string
  category: string
  capabilities: string[]
  source: Record<string, unknown>
  transport: {
    type: string
    endpoint?: string
    url?: string
    command: string
    args: string[]
  }
  env_schema: Array<{
    name: string
    label?: string
    required?: boolean
    required_for_reliable_use?: boolean
    secret?: boolean
    description?: string
  }>
  tool_policy: {
    default_allowed_tools?: string[]
    recommended_tools?: string[]
    dangerous_tools?: string[]
  }
  risk: {
    level: string
    flags?: string[]
    reasons?: string[]
  }
  verification: {
    status: string
    grade?: string
    golden_tests?: string[]
    known_limitations?: string[]
    not_for?: string[]
  }
}

export interface McpCatalog {
  catalog_root: string
  id: string
  name: string
  version: string
  updated_at: string
  registries?: Array<{ id: string; name: string; description?: string }>
  presets: McpPreset[]
}

export interface McpExecutionPolicy {
  remote_enabled: boolean
  stdio_enabled: boolean
  inline_config_enabled: boolean
  remote_private_networks_enabled: boolean
  allowed_transports: string[]
}

export interface McpProbeResult {
  status: string
  server_id: string
  server_name: string
  tools: Array<{ name: string; function_name: string; description: string; parameters: Record<string, unknown> }>
  missing_tools: string[]
  warnings: string[]
  requires_env: string[]
}

export interface McpGoldenTestResult {
  status: string
  passed: boolean
  preset_id: string
  test_id: string
  matched?: Record<string, unknown>
  warnings?: string[]
  error?: string
  raw_preview?: string
}

export type OfficialBadgeStyle = 'metal' | 'minimal'

export interface OfficialBadgeUiSettings {
  style: OfficialBadgeStyle
  allowed_styles: OfficialBadgeStyle[]
  toggle_enabled: boolean
  source: 'env' | 'runtime_override' | string
}

export interface LocalAgentHostPackageInfo {
  version: string
  filename: string
  size_bytes: number
  checksum_algorithm: string
  sha256: string
  download_path: string
  endpoint: string
  mcp_url: string
  manifest_filename: string
  manifest: Record<string, unknown>
  included_files: string[]
  macos: Record<string, string>
  windows: Record<string, string>
  codex_env: Record<string, string>
  claude_env: Record<string, string>
  local_auth_token?: string
  local_auth_token_source?: string
}

export interface LocalAgentHostUpdateInfo {
  status: string
  channel: string
  current_version: string
  latest_version: string
  update_available: boolean
  update_strategy: string
  download_path: string
  checksum_algorithm: string
  sha256: string
  manifest_filename: string
  manifest: Record<string, unknown>
  package: LocalAgentHostPackageInfo
}

export interface AgentWorkspaceFile {
  path: string
  type: 'file' | 'directory' | string
  size: number
}

export interface NativeAgentDraft {
  name: string
  description?: string
  provider_id: string
  model: string
  instructions: string
  agent_md?: string
  skill_ids?: string[]
  skill_recipes?: NativeAgentSkillRecipe[]
  output_contract?: NativeAgent['output_contract']
  runtime_config?: Record<string, unknown>
  is_enabled?: boolean
}

export interface NativeAgentPatch {
  name?: string
  description?: string
  provider_id?: string
  model?: string
  instructions?: string
  agent_md?: string
  skill_ids?: string[]
  skill_recipes?: NativeAgentSkillRecipe[]
  output_contract?: NativeAgent['output_contract']
  runtime_config?: Record<string, unknown>
  is_enabled?: boolean
}

export const nativeAgentApi = {
  ui: {
    officialBadge: () => http<OfficialBadgeUiSettings>('/api/native-agent/ui/official-badge'),
  },
  localAgentHost: {
    info: () => http<LocalAgentHostPackageInfo>('/api/native-agent/local-agent-host/package'),
    update: (currentVersion = '') =>
      http<LocalAgentHostUpdateInfo>(
        `/api/native-agent/local-agent-host/update${currentVersion ? `?current_version=${encodeURIComponent(currentVersion)}` : ''}`,
      ),
    downloadUrl: () => `${BASE}/api/native-agent/local-agent-host/download`,
    download: (fallbackFilename = 'superleaf-local-agent-host.zip') =>
      downloadBackendFile('/api/native-agent/local-agent-host/download', fallbackFilename),
  },
  credentials: {
    list: () => http<NativeAgentCredential[]>('/api/native-agent/credentials'),
    create: (draft: NativeAgentCredentialDraft) =>
      http<NativeAgentCredential>('/api/native-agent/credentials', {
        method: 'POST',
        body: JSON.stringify(draft),
      }),
    update: (id: string, patch: NativeAgentCredentialPatch) =>
      http<NativeAgentCredential>(`/api/native-agent/credentials/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    remove: (id: string) =>
      http<void>(`/api/native-agent/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    probe: (id: string) =>
      http<NativeAgentCredential>(`/api/native-agent/credentials/${encodeURIComponent(id)}/probe`, {
        method: 'POST',
      }),
  },
  skills: {
    list: () => http<Skill[]>('/api/native-agent/skills'),
    create: (draft: SkillDraft) =>
      http<Skill>('/api/native-agent/skills', { method: 'POST', body: JSON.stringify(draft) }),
    createRecipe: (draft: SkillRecipeDraft) =>
      http<Skill>('/api/native-agent/skills/recipe', { method: 'POST', body: JSON.stringify(draft) }),
    update: (id: string, patch: SkillPatch) =>
      http<Skill>(`/api/native-agent/skills/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    publish: (id: string) =>
      http<Skill>(`/api/native-agent/skills/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
      }),
    unpublish: (id: string) =>
      http<Skill>(`/api/native-agent/skills/${encodeURIComponent(id)}/unpublish`, {
        method: 'POST',
      }),
    remove: (id: string) =>
      http<void>(`/api/native-agent/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    usage: (id: string) =>
      http<SkillUsage[]>(`/api/native-agent/skills/${encodeURIComponent(id)}/usage`),
    downloadUrl: (id: string) =>
      `${BASE}/api/native-agent/skills/${encodeURIComponent(id)}/download`,
    download: (id: string, fallbackFilename = 'skill.zip') =>
      downloadBackendFile(`/api/native-agent/skills/${encodeURIComponent(id)}/download`, fallbackFilename),
  },
  marketplace: {
    list: () => http<SkillMarketplace>('/api/native-agent/skill-marketplace'),
    install: (id: string) =>
      http<SkillMarketplaceInstallResult>(`/api/native-agent/skill-marketplace/${encodeURIComponent(id)}/install`, {
        method: 'POST',
      }),
    update: (id: string) =>
      http<SkillMarketplaceInstallResult>(`/api/native-agent/skill-marketplace/${encodeURIComponent(id)}/update`, {
        method: 'POST',
      }),
    uninstall: (id: string) =>
      http<void>(`/api/native-agent/skill-marketplace/${encodeURIComponent(id)}/uninstall`, {
        method: 'DELETE',
      }),
    cloneToLocal: (id: string, name: string) =>
      http<SkillMarketplaceCloneResult>(`/api/native-agent/skill-marketplace/${encodeURIComponent(id)}/clone-to-local`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
  },
  mcp: {
    policy: () => http<McpExecutionPolicy>('/api/native-agent/mcp/policy'),
    catalog: () => http<McpCatalog>('/api/native-agent/mcp/catalog'),
    servers: () => http<NativeMcpServerConfig[]>('/api/native-agent/mcp/servers'),
    createServer: (body: NativeMcpServerConfigDraft) =>
      http<NativeMcpServerConfig>('/api/native-agent/mcp/servers', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ensurePresetServer: (presetId: string, body?: NativeMcpServerConfigDraft) =>
      http<NativeMcpServerConfig>(`/api/native-agent/mcp/servers/from-preset/${encodeURIComponent(presetId)}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),
    updateServer: (id: string, patch: NativeMcpServerConfigPatch) =>
      http<NativeMcpServerConfig>(`/api/native-agent/mcp/servers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    deleteServer: (id: string) =>
      http<void>(`/api/native-agent/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    probeServer: (id: string) =>
      http<McpProbeResult>(`/api/native-agent/mcp/servers/${encodeURIComponent(id)}/probe`, {
        method: 'POST',
      }),
    goldenTestServer: (id: string, body?: { test_id?: string }) =>
      http<McpGoldenTestResult>(`/api/native-agent/mcp/servers/${encodeURIComponent(id)}/golden-test`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),
    probe: (body: { preset_id?: string; server?: NativeAgentMcpServer; env?: Record<string, string>; allowed_tools?: string[] }) =>
      http<McpProbeResult>('/api/native-agent/mcp/probe', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    goldenTest: (body: { preset_id: string; test_id?: string; server?: NativeAgentMcpServer; env?: Record<string, string> }) =>
      http<McpGoldenTestResult>('/api/native-agent/mcp/golden-test', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  agents: {
    list: (providerId?: string) => {
      const qs = providerId ? `?provider_id=${encodeURIComponent(providerId)}` : ''
      return http<NativeAgent[]>(`/api/native-agent/agents${qs}`)
    },
    create: (draft: NativeAgentDraft) =>
      http<NativeAgent>('/api/native-agent/agents', {
        method: 'POST',
        body: JSON.stringify(draft),
      }),
    update: (id: string, patch: NativeAgentPatch) =>
      http<NativeAgent>(`/api/native-agent/agents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    installs: (id: string) =>
      http<NativeAgentSkillInstall[]>(`/api/native-agent/agents/${encodeURIComponent(id)}/skills`),
    installSkill: (id: string, recipe: NativeAgentSkillRecipe) =>
      http<NativeAgentSkillInstall>(`/api/native-agent/agents/${encodeURIComponent(id)}/skills/install-npx`, {
        method: 'POST',
        body: JSON.stringify(recipe),
      }),
    workspaceTree: (id: string) =>
      http<AgentWorkspaceFile[]>(`/api/native-agent/agents/${encodeURIComponent(id)}/workspace/tree`),
    remove: (id: string) =>
      http<void>(`/api/native-agent/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
}

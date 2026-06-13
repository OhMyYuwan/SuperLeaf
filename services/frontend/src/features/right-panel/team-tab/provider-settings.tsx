/**
 * Codex / Claude provider settings: default drafts, meta readers, patch
 * builders and the inline settings field components used by both ProviderForm
 * (create) and ProviderBlock (edit).
 */

import type { Provider, ProviderDraft, ProviderModel, ProviderUpdate } from '../../../services/backendApi'
import { enumMeta, stringMeta } from './meta'
import { codexModelOptionLabel } from './agent-presentation'

export const DEFAULT_CODEX_SETTINGS = {
  codex_model: '',
  codex_effort: 'low',
  codex_summary: 'none',
  codex_service_tier: '',
  codex_sandbox: 'danger-full-access',
  codex_approval_policy: 'on-request',
  codex_prompt_mode: 'fast-edit',
  codex_tool_mode: 'mcp-first',
  codex_context_mode: 'lease',
} satisfies Partial<ProviderDraft>

export const DEFAULT_CLAUDE_SETTINGS = {
  claude_model: '',
  claude_prompt_mode: 'fast-edit',
  claude_tool_mode: 'mcp-first',
} satisfies Partial<ProviderDraft>

export type CodexSettingsDraft = Pick<
  ProviderDraft,
  | 'codex_model'
  | 'codex_effort'
  | 'codex_summary'
  | 'codex_service_tier'
  | 'codex_sandbox'
  | 'codex_approval_policy'
  | 'codex_prompt_mode'
  | 'codex_tool_mode'
  | 'codex_context_mode'
>

export type ClaudeSettingsDraft = Pick<
  ProviderDraft,
  | 'claude_model'
  | 'claude_prompt_mode'
  | 'claude_tool_mode'
>

export function localAgentWorkspacePath(provider: Provider): string {
  if (provider.kind !== 'codex-local' && provider.kind !== 'claude-local') return ''
  return typeof provider.meta?.workspace_path === 'string' ? provider.meta.workspace_path : ''
}

export function codexProviderSettings(provider: Provider): Partial<ProviderUpdate> {
  if (provider.kind !== 'codex-local') return {}
  return {
    codex_model: stringMeta(provider.meta, 'codex_model'),
    codex_effort: enumMeta(provider.meta, 'codex_effort', ['none', 'low', 'medium', 'high', 'xhigh'], 'low') as ProviderDraft['codex_effort'],
    codex_summary: enumMeta(provider.meta, 'codex_summary', ['none', 'auto', 'concise', 'detailed'], 'none') as ProviderDraft['codex_summary'],
    codex_service_tier: stringMeta(provider.meta, 'codex_service_tier'),
    codex_sandbox: enumMeta(provider.meta, 'codex_sandbox', ['read-only', 'workspace-write', 'danger-full-access'], 'danger-full-access') as ProviderDraft['codex_sandbox'],
    codex_approval_policy: enumMeta(provider.meta, 'codex_approval_policy', ['never', 'untrusted', 'on-request', 'on-failure'], 'on-request') as ProviderDraft['codex_approval_policy'],
    codex_prompt_mode: enumMeta(provider.meta, 'codex_prompt_mode', ['fast-edit', 'full-agent'], 'fast-edit') as ProviderDraft['codex_prompt_mode'],
    codex_tool_mode: enumMeta(provider.meta, 'codex_tool_mode', ['mcp-first', 'browser-preflight', 'marker-only'], 'mcp-first') as ProviderDraft['codex_tool_mode'],
    codex_context_mode: enumMeta(provider.meta, 'codex_context_mode', ['legacy-blocks', 'lease'], 'lease') as ProviderDraft['codex_context_mode'],
  }
}

export function claudeProviderSettings(provider: Provider): Partial<ProviderUpdate> {
  if (provider.kind !== 'claude-local') return {}
  return {
    claude_model: stringMeta(provider.meta, 'claude_model'),
    claude_prompt_mode: enumMeta(provider.meta, 'claude_prompt_mode', ['fast-edit', 'full-agent'], 'fast-edit') as ProviderDraft['claude_prompt_mode'],
    claude_tool_mode: enumMeta(provider.meta, 'claude_tool_mode', ['mcp-first', 'browser-preflight', 'marker-only'], 'mcp-first') as ProviderDraft['claude_tool_mode'],
  }
}

export function codexSettingsPatch(source: Partial<CodexSettingsDraft>): Partial<ProviderUpdate> {
  return {
    codex_model: source.codex_model?.trim() ?? '',
    codex_effort: source.codex_effort === 'minimal' ? 'low' : source.codex_effort ?? 'low',
    codex_summary: source.codex_summary ?? 'none',
    codex_service_tier: source.codex_service_tier?.trim() ?? '',
    codex_sandbox: source.codex_sandbox ?? 'danger-full-access',
    codex_approval_policy: source.codex_approval_policy ?? 'on-request',
    codex_prompt_mode: source.codex_prompt_mode ?? 'fast-edit',
    codex_tool_mode: source.codex_tool_mode ?? 'mcp-first',
    codex_context_mode: source.codex_context_mode ?? 'lease',
  }
}

export function claudeSettingsPatch(source: Partial<ClaudeSettingsDraft>): Partial<ProviderUpdate> {
  return {
    claude_model: source.claude_model?.trim() ?? '',
    claude_prompt_mode: source.claude_prompt_mode ?? 'fast-edit',
    claude_tool_mode: source.claude_tool_mode ?? 'mcp-first',
  }
}

export function CodexSettingsFields({
  draft,
  modelOptions,
  modelLoading,
  onChange,
}: {
  draft: Partial<CodexSettingsDraft>
  modelOptions: ProviderModel[]
  modelLoading?: boolean
  onChange: (patch: Partial<CodexSettingsDraft>) => void
}) {
  const selectedModel = draft.codex_model ?? ''
  const selectedModelInOptions = !selectedModel || modelOptions.some((model) => model.id === selectedModel)
  return (
    <div className="codex-settings-compact">
      <label className="codex-field codex-field-full">
        <span>Model</span>
          <select
            className="codex-select"
            value={selectedModel}
            onChange={(event) => onChange({ codex_model: event.target.value })}
          >
            <option value="">使用本机默认</option>
            {!selectedModelInOptions && (
              <option value={selectedModel}>当前已保存：{selectedModel}</option>
            )}
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {codexModelOptionLabel(model)}
              </option>
            ))}
            {modelOptions.length === 0 && (
              <option value="" disabled>
                {modelLoading ? '正在读取本机模型…' : '连接后自动加载模型'}
              </option>
            )}
          </select>
      </label>
      <CodexSegmentedControl
        label="Access"
        value={draft.codex_sandbox === 'read-only' ? 'read-only' : 'danger-full-access'}
        options={[
          { value: 'danger-full-access', label: 'Full' },
          { value: 'read-only', label: '只读' },
        ]}
        onChange={(value) => onChange({ codex_sandbox: value as ProviderDraft['codex_sandbox'] })}
      />
      <CodexSegmentedControl
        label="Mode"
        value={draft.codex_prompt_mode ?? 'fast-edit'}
        options={[
          { value: 'fast-edit', label: '快速编辑' },
          { value: 'full-agent', label: '完整 Agent' },
        ]}
        onChange={(value) => onChange({ codex_prompt_mode: value as ProviderDraft['codex_prompt_mode'] })}
      />
      <CodexSegmentedControl
        label="Tools"
        value={draft.codex_tool_mode ?? 'mcp-first'}
        options={[
          { value: 'mcp-first', label: 'MCP' },
          { value: 'browser-preflight', label: '浏览器优先' },
          { value: 'marker-only', label: '标记' },
        ]}
        onChange={(value) => onChange({ codex_tool_mode: value as ProviderDraft['codex_tool_mode'] })}
      />
      <CodexSegmentedControl
        label="Context"
        value={draft.codex_context_mode ?? 'lease'}
        options={[
          { value: 'lease', label: '轻量缓存' },
          { value: 'legacy-blocks', label: '兼容完整提示' },
        ]}
        onChange={(value) => onChange({ codex_context_mode: value as ProviderDraft['codex_context_mode'] })}
      />
      <details className="codex-advanced">
        <summary>高级设置</summary>
        <div className="codex-advanced-grid">
          <CodexSegmentedControl
            label="Reasoning"
            value={draft.codex_effort ?? 'low'}
            options={[
              { value: 'low', label: 'low' },
              { value: 'medium', label: 'medium' },
              { value: 'high', label: 'high' },
              { value: 'none', label: 'none' },
            ]}
            onChange={(value) => onChange({ codex_effort: value as ProviderDraft['codex_effort'] })}
          />
          <CodexSegmentedControl
            label="Summary"
            value={draft.codex_summary ?? 'none'}
            options={[
              { value: 'none', label: 'none' },
              { value: 'auto', label: 'auto' },
              { value: 'concise', label: 'concise' },
              { value: 'detailed', label: 'detailed' },
            ]}
            onChange={(value) => onChange({ codex_summary: value as ProviderDraft['codex_summary'] })}
          />
          <label className="codex-field codex-field-full">
            <span>Service Tier</span>
            <input
              value={draft.codex_service_tier ?? ''}
              onChange={(event) => onChange({ codex_service_tier: event.target.value })}
              placeholder="本机默认"
            />
          </label>
        </div>
      </details>
    </div>
  )
}

function CodexSegmentedControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <div className="codex-field">
      <span>{label}</span>
      <div className="codex-segmented" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={option.value === value ? 'active' : ''}
            onClick={() => onChange(option.value)}
            aria-pressed={option.value === value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ClaudeSettingsFields({
  draft,
  onChange,
}: {
  draft: Partial<ClaudeSettingsDraft>
  onChange: (patch: Partial<ClaudeSettingsDraft>) => void
}) {
  return (
    <>
      <div className="form-row">
        <label>
          <span>Claude Model</span>
          <select
            value={draft.claude_model ?? ''}
            onChange={(event) => onChange({ claude_model: event.target.value })}
          >
            <option value="">使用本机默认</option>
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
          </select>
        </label>
        <label>
          <span>Prompt Mode</span>
          <select
            value={draft.claude_prompt_mode ?? 'fast-edit'}
            onChange={(event) => onChange({ claude_prompt_mode: event.target.value as ProviderDraft['claude_prompt_mode'] })}
          >
            <option value="fast-edit">快速编辑</option>
            <option value="full-agent">完整 Agent</option>
          </select>
        </label>
      </div>
      <label className="full">
        <span>Tool Mode</span>
        <select
          value={draft.claude_tool_mode ?? 'mcp-first'}
          onChange={(event) => onChange({ claude_tool_mode: event.target.value as ProviderDraft['claude_tool_mode'] })}
        >
          <option value="mcp-first">MCP first</option>
          <option value="browser-preflight">Browser preflight first</option>
          <option value="marker-only">Marker fallback only</option>
        </select>
        <small>
          MCP first 会把 SuperLeaf /mcp 通过 Local Host 绑定给本机 Claude Code。
        </small>
      </label>
    </>
  )
}

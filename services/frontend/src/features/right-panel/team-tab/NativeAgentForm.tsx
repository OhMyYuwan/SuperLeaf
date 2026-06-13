/**
 * NativeAgentForm — create / edit a native Agent: model picker, AGENT.md,
 * skill assembly and MCP tool selection (preset + custom owned configs).
 */

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type {
  NativeAgent,
  NativeAgentDraft,
  NativeMcpServerConfig,
  ProviderModel,
  Skill,
} from '../../../services/backendApi'
import { useNativeAgentStore } from '../../../stores/nativeAgentStore'
import { OfficialSkillBadge } from './badges'
import { skillLabel, skillPillLabel } from './skill-utils'
import {
  mcpAgentPickerHint,
  mcpEffectivePolicy,
  mcpPresetIdsFromRuntime,
  mcpRegistryLabel,
  mcpServerAllowedByPolicy,
  mcpServerIdsFromRuntime,
  mcpServersFromRuntime,
  ownedMcpName,
  writeMcpSelection,
} from './mcp-utils'

export function NativeAgentForm({
  providerId,
  agent,
  modelOptions,
  modelError,
  skills,
  onCancel,
  onSave,
}: {
  providerId: string
  agent?: NativeAgent
  modelOptions: ProviderModel[]
  modelError?: string | null
  skills: Skill[]
  onCancel: () => void
  onSave: (draft: NativeAgentDraft) => Promise<void>
}) {
  const initialModel = agent?.model || modelOptions[0]?.id || 'gpt-4.1-mini'
  const [modelMode, setModelMode] = useState<'select' | 'custom'>(
    modelOptions.length > 0 && (!agent || modelOptions.some((model) => model.id === agent.model))
      ? 'select'
      : 'custom',
  )
  const [draft, setDraft] = useState<NativeAgentDraft>({
    name: agent?.name ?? '',
    description: agent?.description ?? '',
    provider_id: providerId,
    model: initialModel,
    instructions: agent?.instructions ?? '',
    agent_md: agent?.agent_md || agent?.instructions || '',
    skill_ids: agent?.skill_ids ?? [],
    output_contract: agent?.output_contract ?? 'annotation',
    runtime_config: agent?.runtime_config ?? {},
    is_enabled: agent?.is_enabled ?? true,
  })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const mcpCatalog = useNativeAgentStore((s) => s.mcpCatalog)
  const mcpCatalogLoading = useNativeAgentStore((s) => s.mcpCatalogLoading)
  const loadMcpCatalog = useNativeAgentStore((s) => s.loadMcpCatalog)
  const mcpPolicy = useNativeAgentStore((s) => s.mcpPolicy)
  const mcpPolicyLoading = useNativeAgentStore((s) => s.mcpPolicyLoading)
  const loadMcpPolicy = useNativeAgentStore((s) => s.loadMcpPolicy)
  const mcpConfigs = useNativeAgentStore((s) => s.mcpServers)
  const mcpConfigsLoaded = useNativeAgentStore((s) => s.mcpServersLoaded)
  const mcpConfigsLoading = useNativeAgentStore((s) => s.mcpServersLoading)
  const loadMcpServers = useNativeAgentStore((s) => s.loadMcpServers)
  const mcpPresets = useMemo(() => mcpCatalog?.presets ?? [], [mcpCatalog])
  const presetById = useMemo(() => new Map(mcpPresets.map((preset) => [preset.id, preset])), [mcpPresets])
  const ownedPresetMcpConfigs = useMemo(() => mcpConfigs.filter((server) => Boolean(server.preset_id)), [mcpConfigs])
  const customMcpConfigs = useMemo(() => mcpConfigs.filter((server) => !server.preset_id), [mcpConfigs])
  const selectedPresetIds = useMemo(() => new Set(mcpPresetIdsFromRuntime(draft.runtime_config)), [draft.runtime_config])
  const selectedServerIds = useMemo(() => new Set(mcpServerIdsFromRuntime(draft.runtime_config)), [draft.runtime_config])
  const legacyMcpServers = mcpServersFromRuntime(draft.runtime_config)
  const effectiveMcpPolicy = useMemo(() => mcpEffectivePolicy(mcpPolicy), [mcpPolicy])

  const modelInOptions = modelOptions.some((model) => model.id === draft.model)
  const effectiveModelMode = modelMode === 'select' && modelInOptions ? 'select' : 'custom'

  useEffect(() => {
    if (!mcpCatalog && !mcpCatalogLoading) void loadMcpCatalog()
  }, [mcpCatalog, mcpCatalogLoading, loadMcpCatalog])

  useEffect(() => {
    if (!mcpPolicy && !mcpPolicyLoading) void loadMcpPolicy()
  }, [mcpPolicy, mcpPolicyLoading, loadMcpPolicy])

  useEffect(() => {
    if (!mcpConfigsLoaded && !mcpConfigsLoading) void loadMcpServers()
  }, [mcpConfigsLoaded, mcpConfigsLoading, loadMcpServers])

  useEffect(() => {
    if (agent || !mcpConfigsLoaded || ownedPresetMcpConfigs.length === 0) return
    setDraft((prev) => {
      if (
        mcpPresetIdsFromRuntime(prev.runtime_config).length > 0 ||
        mcpServerIdsFromRuntime(prev.runtime_config).length > 0 ||
        mcpServersFromRuntime(prev.runtime_config).length > 0
      ) {
        return prev
      }
      const defaultServerIds = ownedPresetMcpConfigs
        .filter((server) => (
          server.is_enabled &&
          mcpServerAllowedByPolicy(server, effectiveMcpPolicy) &&
          presetById.get(server.preset_id)?.verification?.status === 'verified'
        ))
        .map((server) => server.id)
      if (defaultServerIds.length === 0) return prev
      return {
        ...prev,
        runtime_config: writeMcpSelection(prev.runtime_config, [], defaultServerIds),
      }
    })
  }, [agent, effectiveMcpPolicy, mcpConfigsLoaded, ownedPresetMcpConfigs, presetById])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setFormError(null)
    if (!draft.name.trim() || !draft.model.trim()) {
      setFormError('名称和模型不能为空')
      return
    }
    setSaving(true)
    await onSave({
      ...draft,
      name: draft.name.trim(),
      model: draft.model.trim(),
      instructions: draft.instructions.trim(),
      agent_md: (draft.agent_md || draft.instructions).trim(),
    })
    setSaving(false)
  }

  const updateMcpSelection = (presetIds: Set<string>, serverIds: Set<string>) => {
    setDraft((prev) => ({
      ...prev,
      runtime_config: writeMcpSelection(prev.runtime_config, [...presetIds], [...serverIds]),
    }))
  }

  const toggleOwnedMcp = (server: NativeMcpServerConfig, checked: boolean) => {
    const nextPresetIds = new Set(selectedPresetIds)
    const nextServerIds = new Set(selectedServerIds)
    if (checked) {
      nextServerIds.add(server.id)
      if (server.preset_id) nextPresetIds.delete(server.preset_id)
    } else {
      nextServerIds.delete(server.id)
      if (server.preset_id) nextPresetIds.delete(server.preset_id)
    }
    updateMcpSelection(nextPresetIds, nextServerIds)
  }

  return (
    <form className="native-agent-inline-form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          <span>Agent 名称</span>
          <input
            value={draft.name}
            onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            autoFocus={!agent}
          />
        </label>
        <label>
          <span>模型</span>
          <div className="model-picker">
            <select
              value={effectiveModelMode === 'select' ? draft.model : '__custom__'}
              onChange={(event) => {
                const value = event.target.value
                if (value === '__custom__') {
                  setModelMode('custom')
                  return
                }
                setModelMode('select')
                setDraft((prev) => ({ ...prev, model: value }))
              }}
            >
              <option value="__custom__">自定义模型名</option>
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name || model.id}
                </option>
              ))}
            </select>
          </div>
          {effectiveModelMode === 'custom' && (
            <input
              value={draft.model}
              onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))}
              placeholder="gpt-4.1-mini"
            />
          )}
          {modelError && <small className="model-error">{modelError}</small>}
        </label>
      </div>
      <label className="full">
        <span>描述</span>
        <input
          value={draft.description}
          onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
          placeholder="这个 Agent 负责什么"
        />
      </label>
      <label className="full">
        <span>AGENT.md</span>
        <textarea
          value={draft.agent_md ?? ''}
          onChange={(event) => setDraft((prev) => ({ ...prev, agent_md: event.target.value, instructions: event.target.value }))}
          rows={5}
          placeholder="写入该 Agent 的 .agents/AGENT.md"
        />
      </label>
      <fieldset className="skill-picker-field">
        <legend>Skill 装配</legend>
        {skills.length === 0 ? (
          <div className="agent-empty-inline">本地 Skill 库为空。先在 Skill 页面安装市场 Skill 或添加自定义 Skill。</div>
        ) : (
          <div className="skill-picker">
            {skills.map((skill) => {
              const checked = draft.skill_ids?.includes(skill.id) ?? false
              return (
                <label key={skill.id} className={`skill-check ${checked ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const next = new Set(draft.skill_ids ?? [])
                      if (event.target.checked) next.add(skill.id)
                      else next.delete(skill.id)
                      setDraft((prev) => ({ ...prev, skill_ids: [...next] }))
                    }}
                  />
                  <span>{skillLabel(skill)}</span>
                  {skill.source === 'marketplace' ? <OfficialSkillBadge /> : <small>{skillPillLabel(skill)}</small>}
                </label>
              )
            })}
          </div>
        )}
      </fieldset>
      <fieldset className="skill-picker-field mcp-picker-field">
        <legend>MCP 工具</legend>
        <p className="mcp-field-note">Agent 这里只选择要开放的 MCP。命令、Env、工具白名单在团队管理的 MCP 标签页维护。</p>
        {mcpConfigsLoading && mcpConfigs.length === 0 && (
          <div className="agent-empty-inline">正在读取拥有的 MCP...</div>
        )}
        {!mcpConfigsLoading && mcpConfigs.length === 0 && (
          <div className="agent-empty-inline">还没有拥有的 MCP。先到 MCP 标签页从市场添加，或创建自定义 MCP。</div>
        )}
        <div className="skill-picker">
          {ownedPresetMcpConfigs.map((server) => {
            const preset = presetById.get(server.preset_id)
            const legacySelected = legacyMcpServers.some((legacy) => legacy.id === server.preset_id && legacy.enabled)
            const checked = selectedServerIds.has(server.id) || selectedPresetIds.has(server.preset_id) || legacySelected
            const policyAllowed = mcpServerAllowedByPolicy(server, effectiveMcpPolicy)
            const hint = mcpAgentPickerHint(server, preset, effectiveMcpPolicy)
            return (
              <label key={server.id} className={`skill-check ${checked ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && (!server.is_enabled || !policyAllowed)}
                  onChange={(event) => toggleOwnedMcp(server, event.target.checked)}
                />
                <span>{ownedMcpName(server, preset)}</span>
                <small>
                  {preset ? `${mcpRegistryLabel(preset)} · ${preset.category}` : '已拥有 MCP'} · {server.is_enabled ? '已启用' : '已停用'}
                  <span className={`mcp-picker-status ${hint.tone}`}>{hint.label}</span>
                  {hint.detail ? ` · ${hint.detail}` : ''}
                </small>
              </label>
            )
          })}
          {customMcpConfigs.map((server) => {
            const checked = selectedServerIds.has(server.id)
            const policyAllowed = mcpServerAllowedByPolicy(server, effectiveMcpPolicy)
            const hint = mcpAgentPickerHint(server, undefined, effectiveMcpPolicy)
            return (
              <label key={server.id} className={`skill-check ${checked ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && (!server.is_enabled || !policyAllowed)}
                  onChange={(event) => toggleOwnedMcp(server, event.target.checked)}
                />
                <span>{ownedMcpName(server)}</span>
                <small>
                  自定义 · {server.is_enabled ? '已启用' : '已停用'}
                  <span className={`mcp-picker-status ${hint.tone}`}>{hint.label}</span>
                  {hint.detail ? ` · ${hint.detail}` : ''}
                </small>
              </label>
            )
          })}
        </div>
        {legacyMcpServers.length > 0 && (
          <div className="agent-empty-inline">检测到 {legacyMcpServers.length} 个旧版内联 MCP 配置；公开部署默认不会执行内联配置，下一次修改 MCP 选择后会迁移为引用式配置。</div>
        )}
      </fieldset>
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-actions">
        <button type="button" className="ghost-btn" onClick={onCancel} disabled={saving}>
          取消
        </button>
        <button type="submit" className="primary-btn" disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : agent ? '保存 Agent' : '添加 Agent'}
        </button>
      </div>
    </form>
  )
}

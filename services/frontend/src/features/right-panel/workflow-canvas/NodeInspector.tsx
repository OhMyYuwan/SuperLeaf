/**
 * NodeInspector — right-side config editor for the selected node.
 *
 * agent: either a team agent reference, or inline Native Agent config
 * loop:  rounds (iteration count)
 */

import { useEffect, useState } from 'react'
import { useWorkflowStore } from '../../../stores/workflowStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useNativeAgentStore } from '../../../stores/nativeAgentStore'
import type { Provider, Skill } from '../../../services/backendApi'
import { codexModelOptionLabel, modelsFromProviderMeta } from '../team-tab/agent-presentation'
import { isInlineAgentConfig, type FlowNode, type FlowNodeData } from './graphConversion'
import { formatWorkflowAgentOption } from './agentOptionFormat'
import {
  addInlineSkillRef,
  inlineSkillRefKey,
  readInlineSkillRefs,
  removeInlineSkillRef,
  updateInlineSkillRefAlias,
  type InlineAgentSkillRef,
} from './inlineSkillRefs'

interface NodeInspectorProps {
  node: FlowNode | null
  onUpdate: (id: string, patch: Partial<FlowNodeData>) => void
  onDelete: (id: string) => void
  onClose: () => void
}

export function NodeInspector({ node, onUpdate, onDelete, onClose }: NodeInspectorProps) {
  const allWorkflows = useWorkflowStore((s) => s.workflows)
  const providers = useSettingsStore((s) => s.providers)
  const providerNamesById = new Map(providers.map((provider) => [provider.id, provider.name]))
  if (!node) {
    return (
      <aside className="wf-inspector">
        <div className="wf-inspector-empty">
          选中一个节点查看 / 编辑属性
        </div>
      </aside>
    )
  }

  const { data } = node
  const setLabel = (label: string) => onUpdate(node.id, { label })
  const setConfig = (patch: Record<string, unknown>) =>
    onUpdate(node.id, { config: { ...data.config, ...patch } })

  return (
    <aside className="wf-inspector">
      <div className="wf-inspector-header">
        <span>{inspectorHeaderLabel(data.nodeType)}</span>
        <div className="wf-inspector-actions">
          <button className="secondary-btn" onClick={onClose}>收起</button>
          <button className="danger-btn" onClick={() => onDelete(node.id)}>
            删除
          </button>
        </div>
      </div>

      <div className="form-group">
        <label>节点 ID</label>
        <input type="text" value={node.id} disabled />
      </div>

      <div className="form-group">
        <label>显示名称</label>
        <input
          type="text"
          value={data.label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={inspectorHeaderLabel(data.nodeType)}
        />
      </div>

      {data.nodeType === 'input' && <InputNodeForm data={data} setConfig={setConfig} />}
      {data.nodeType === 'output' && <OutputNodeForm data={data} setConfig={setConfig} />}

      {data.nodeType === 'agent' && (() => {
        const currentAgentId = readAgentId(data.config)
        const allowProjectContext = Boolean(
          data.config.allow_project_context ?? data.config.allowProjectContext,
        )
        const additionalPrompt = readVisibleAdditionalPrompt(data.config)
        const inlineMode = isInlineAgentConfig(data.config)
        const activeAgents = allWorkflows.filter((w) => !w.is_disabled)
        const disabledAgents = allWorkflows.filter((w) => w.is_disabled)
        const selectedAgent = allWorkflows.find((w) => w.id === currentAgentId)
        const selectedIsDisabled = selectedAgent?.is_disabled ?? false
        const selectedIsOrphan = currentAgentId !== '' && !selectedAgent
        const switchAgentSource = (source: 'team' | 'inline') => {
          if (source === 'inline') {
            setConfig({
              agent_source: 'inline',
              inline_agent: true,
              agent_id: undefined,
              agentId: undefined,
              provider: isPlainRecord(data.config.provider) ? data.config.provider : {},
              provider_ref: undefined,
              skill_names: Array.isArray(data.config.skill_names) ? data.config.skill_names : [],
              instructions:
                typeof data.config.instructions === 'string' ? data.config.instructions : '',
              runtime_config: isPlainRecord(data.config.runtime_config)
                ? data.config.runtime_config
                : {},
            })
            return
          }
          setConfig({
            agent_source: 'team',
            inline_agent: false,
            provider: undefined,
            provider_ref: undefined,
            skill_names: undefined,
            instructions: undefined,
            runtime_config: undefined,
          })
        }
        const agentTypeSelector = (
          <div className="form-group">
            <label>Agent 类型</label>
            <select
              value={inlineMode ? 'inline' : 'team'}
              onChange={(e) => switchAgentSource(e.target.value === 'inline' ? 'inline' : 'team')}
            >
              <option value="team">团队 Agent</option>
              <option value="inline">临时 Agent（Native）</option>
            </select>
            <div className="form-hint-sm">
              团队 Agent 引用已定义配置；临时 Agent 的指令、Skills、MCP 配置随 Workflow JSON 迁移。
            </div>
          </div>
        )

        if (inlineMode) {
          return (
            <>
              {agentTypeSelector}
              <InlineAgentForm key={node.id} data={data} setConfig={setConfig} />
            </>
          )
        }

        return (
          <>
            {agentTypeSelector}
            <div className="form-group">
              <label>Agent</label>
              <select
                value={currentAgentId}
                onChange={(e) => setConfig({ agent_id: e.target.value, agentId: undefined })}
                className={selectedIsDisabled || selectedIsOrphan ? 'input-warning' : ''}
              >
                <option value="">— 未选择 Agent —</option>
                {activeAgents.map((w) => (
                  <option key={w.id} value={w.id}>
                    {formatWorkflowAgentOption(w, providerNamesById)}
                  </option>
                ))}
                {/*
                  Disabled agents pinned to the bottom and non-selectable. We
                  still render them so existing configs keep their context when
                  the user opens the dropdown, rather than vanishing silently.
                */}
                {disabledAgents.length > 0 && (
                  <optgroup label="— 已禁用（不可选）—">
                    {disabledAgents.map((w) => (
                      <option key={w.id} value={w.id} disabled className="option-disabled">
                        {formatWorkflowAgentOption(w, providerNamesById)}（已禁用）
                      </option>
                    ))}
                  </optgroup>
                )}
                {selectedIsOrphan && (
                  <optgroup label="— 已删除 —">
                    <option value={currentAgentId} disabled className="option-disabled">
                      未知 Agent · {currentAgentId.slice(0, 8)}…（已删除）
                    </option>
                  </optgroup>
                )}
              </select>
              {selectedIsDisabled && (
                <div className="form-hint-sm form-hint-warning">
                  该 Agent 已被禁用，执行前请更换。
                </div>
              )}
              {selectedIsOrphan && (
                <div className="form-hint-sm form-hint-warning">
                  未在团队列表中找到该 Agent，可能已被删除。
                </div>
              )}
              {!selectedIsDisabled && !selectedIsOrphan && (
                <div className="form-hint-sm">
                  从团队中选择一个 Agent。已禁用的 Agent 置底且不可选。
                </div>
              )}
            </div>

            <div className="form-group">
              <label>额外提示词（可选）</label>
              <textarea
                value={additionalPrompt}
                onChange={(e) =>
                  setConfig({ additional_prompt: e.target.value, promptHint: undefined })
                }
                placeholder="在 workflow 中给这个 agent 的额外指令，例如：&#10;- 你的输入来自上游节点的输出&#10;- 请输出 JSON 格式：{result, confidence}&#10;- 保持简洁，不超过 100 字"
                rows={4}
              />
              <div className="form-hint-sm">
                节点级提示词，会注入到 agent 的系统提示中，告诉它在 workflow 中的角色和输出要求。
              </div>
            </div>

            <div className="form-group">
              <label className="form-label-inline">
                <input
                  type="checkbox"
                  checked={allowProjectContext}
                  onChange={(e) =>
                    setConfig({
                      allow_project_context: e.target.checked,
                      allowProjectContext: undefined,
                    })
                  }
                />
                允许读取项目文档
              </label>
              <div className="form-hint-sm">
                默认关闭。打开后，该节点可以在提示词明确要求时读取项目文档；接龙、投票、收敛判断等纯群聊节点建议保持关闭。
              </div>
            </div>
          </>
        )
      })()}

      {data.nodeType === 'loop' && (
        <>
          <div className="form-group">
            <label>循环次数</label>
            <input
              type="number"
              min={1}
              max={20}
              value={(data.config.rounds as number) ?? 3}
              onChange={(e) =>
                setConfig({ rounds: Math.max(1, Math.min(20, Number(e.target.value))) })
              }
            />
            <div className="form-hint-sm">
              容器内所有节点作为整体执行这么多次。
            </div>
          </div>
          <div className="form-group">
            <label>停止条件（可选）</label>
            <textarea
              value={(data.config.stop_condition as string) ?? ''}
              onChange={(e) => setConfig({ stop_condition: e.target.value })}
              placeholder="例如：last_output.includes('DONE')"
              rows={2}
            />
            <div className="form-hint-sm">
              提前终止的表达式。未填写则跑满 rounds。
            </div>
          </div>
          <div className="form-hint-sm" style={{ marginTop: '12px', padding: '8px', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '6px', lineHeight: 1.6 }}>
            💡 <strong>Loop 归属由连线方向自动判定</strong>
            <br />· 从 Loop 端口 <strong>拖出</strong> 到 Agent ：该 Agent 在 Loop <strong>内部</strong>
            <br />&nbsp;&nbsp;&nbsp;（左侧端口 → Agent 输入：分发；Agent 输出 → 右侧端口：汇总）
            <br />· 从 Agent <strong>拖入</strong> Loop 端口：该 Agent 在 Loop <strong>外部</strong>
            <br />&nbsp;&nbsp;&nbsp;（外部 Agent → 左侧端口：外部输入；右侧端口 → 外部 Agent：最终输出）
          </div>
        </>
      )}
    </aside>
  )
}

function readAgentId(config: Record<string, unknown>): string {
  const raw = config.agent_id ?? config.agentId
  return typeof raw === 'string' ? raw.trim() : ''
}

function readVisibleAdditionalPrompt(config: Record<string, unknown>): string {
  const raw = config.additional_prompt ?? config.promptHint
  return typeof raw === 'string' ? raw : ''
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

interface InlineProviderConfig {
  provider_id?: string
  model?: string
  // Legacy workflow JSON may still contain runtime knobs here. New edits drop them.
  temperature?: number
  max_tokens?: number
}

function readInlineProviderConfig(config: Record<string, unknown>): InlineProviderConfig {
  const raw = isPlainRecord(config.provider) ? config.provider : {}
  return {
    provider_id: readString(raw.provider_id),
    model: readString(raw.model),
    temperature: readFiniteNumber(raw.temperature),
    max_tokens: readFiniteNumber(raw.max_tokens),
  }
}

export function pruneInlineProviderConfig(config: InlineProviderConfig): InlineProviderConfig {
  const next: InlineProviderConfig = {}
  if (config.provider_id?.trim()) next.provider_id = config.provider_id.trim()
  if (config.model?.trim()) next.model = config.model.trim()
  return next
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function inspectorHeaderLabel(type: FlowNodeData['nodeType']): string {
  if (type === 'loop') return 'Loop 容器'
  if (type === 'input') return 'Input 节点'
  if (type === 'output') return 'Output 节点'
  return 'Agent 节点'
}

interface SubFormProps {
  data: FlowNodeData
  setConfig: (patch: Record<string, unknown>) => void
}

/**
 * Input node config. Selection text + user instruction are always injected by
 * the backend from the run body; the checkbox merely controls whether the
 * instruction reaches downstream prompts. Context files are managed by the
 * Phase 4 @-mention flow and appear here as a read-only summary.
 */
function InputNodeForm({ data, setConfig }: SubFormProps) {
  const includeInstruction = (data.config.include_instruction as boolean) ?? true
  const contextFiles = Array.isArray(data.config.context_files)
    ? (data.config.context_files as Array<{ name?: string; document_id?: string }>)
    : []

  return (
    <>
      <div className="form-group">
        <label>自动注入</label>
        <div className="form-readonly-list">
          <div>· 选中文本（来自编辑器选择）</div>
          <div>· 运行时指令（来自输入栏）</div>
        </div>
        <div className="form-hint-sm">
          这些字段由系统自动填充，输入节点把它们暴露给下游。
        </div>
      </div>

      <div className="form-group">
        <label className="form-label-inline">
          <input
            type="checkbox"
            checked={includeInstruction}
            onChange={(e) => setConfig({ include_instruction: e.target.checked })}
          />
          将用户指令传递给下游
        </label>
        <div className="form-hint-sm">
          关闭后，下游 agent 只看到选中文本，不看到用户指令。
        </div>
      </div>

      <div className="form-group">
        <label>引用文件（{contextFiles.length}）</label>
        {contextFiles.length === 0 ? (
          <div className="form-readonly-list empty">尚未引用任何文件</div>
        ) : (
          <ul className="form-file-list">
            {contextFiles.map((f, i) => (
              <li key={i}>
                <span>📄 {f.name ?? f.document_id ?? `file-${i}`}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="form-hint-sm">
          通过右上输入栏的 @ 引用文件（Phase 4 上线）。文件内容会整块注入 Input 输出。
        </div>
      </div>
    </>
  )
}

/**
 * Output node config. `format` decides the final output contract.
 *
 * Important distinction:
 *   - `annotations` means the payload is shaped as
 *     {annotations} so the annotation panel can consume it.
 *   - Whether that payload is auto-ingested into the annotation column depends
 *     on the *run entrypoint*: workflow runs from the annotation/workflow path
 *     auto-ingest; discussion/chat flows keep the result in chat until the user
 *     explicitly converts it.
 */
function OutputNodeForm({ data, setConfig }: SubFormProps) {
  const format = (data.config.format as string) ?? 'text'
  const sourceIds = Array.isArray(data.config.source_node_ids)
    ? (data.config.source_node_ids as string[])
    : []

  return (
    <>
      <div className="form-group">
        <label>输出格式</label>
        <select value={format} onChange={(e) => setConfig({ format: e.target.value })}>
          <option value="text">纯文本（拼接上游输出）</option>
          <option value="json">JSON（合并上游结构化输出）</option>
          <option value="annotations">注释卡片（批注）</option>
        </select>
        <div className="form-hint-sm">
          注释卡片表示最终输出契约为 annotations。通过工作流入口运行时会自动进入批注列；聊天入口后续由用户手动转入批注列。
        </div>
      </div>

      <div className="form-group">
        <label>源节点（可选）</label>
        <input
          type="text"
          value={sourceIds.join(',')}
          onChange={(e) =>
            setConfig({
              source_node_ids: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="留空 = 所有直接上游"
        />
        <div className="form-hint-sm">
          逗号分隔节点 ID。留空则聚合所有指向本 Output 的节点。
        </div>
      </div>
    </>
  )
}

/**
 * Inline Agent config. Defines an agent directly in the workflow without
 * referencing a team agent. Supports skill_names, instructions, and
 * node-local provider config for workflow migration.
 */
function InlineAgentForm({ data, setConfig }: SubFormProps) {
  const skillNames = Array.isArray(data.config.skill_names)
    ? (data.config.skill_names as string[])
    : []
  const skillRefs = readInlineSkillRefs(data.config.skills)
  const nativeSkills = useNativeAgentStore((s) => s.skills)
  const nativeLoaded = useNativeAgentStore((s) => s.loaded)
  const nativeLoading = useNativeAgentStore((s) => s.loading)
  const loadNativeAgents = useNativeAgentStore((s) => s.loadAll)
  const providers = useSettingsStore((s) => s.providers)
  const providersLoaded = useSettingsStore((s) => s.loaded)
  const loadProviders = useSettingsStore((s) => s.load)
  const instructions = typeof data.config.instructions === 'string' ? data.config.instructions : ''
  const providerRef = typeof data.config.provider_ref === 'string' ? data.config.provider_ref : ''
  const providerConfig = readInlineProviderConfig(data.config)
  const nativeProviders = providers.filter((provider) => provider.kind === 'native')
  const selectedProvider =
    providerConfig.provider_id
      ? providers.find((provider) => provider.id === providerConfig.provider_id)
      : undefined
  const modelOptions = selectedProvider ? modelsFromProviderMeta(selectedProvider.meta) : []
  const selectedModelInOptions =
    !providerConfig.model || modelOptions.some((model) => model.id === providerConfig.model)
  const allowProjectContext = Boolean(
    data.config.allow_project_context ?? data.config.allowProjectContext,
  )
  const additionalPrompt = readVisibleAdditionalPrompt(data.config)
  const selectedSkillIds = new Set(
    skillRefs.map((ref) => ref.skill_id || ref.source_skill_id).filter(Boolean),
  )
  const availableSkills = nativeSkills.filter((skill) => !selectedSkillIds.has(skill.id))
  const skillsById = new Map(nativeSkills.map((skill) => [skill.id, skill]))
  const [runtimeText, setRuntimeText] = useState(formatRuntimeConfigJson(data.config.runtime_config))
  const [runtimeError, setRuntimeError] = useState('')
  const [selectedSkillId, setSelectedSkillId] = useState('')

  useEffect(() => {
    if (!nativeLoaded && !nativeLoading) void loadNativeAgents()
  }, [loadNativeAgents, nativeLoaded, nativeLoading])

  useEffect(() => {
    if (!providersLoaded) void loadProviders()
  }, [loadProviders, providersLoaded])

  const updateProviderConfig = (patch: Partial<InlineProviderConfig>) => {
    setConfig({
      provider: pruneInlineProviderConfig({ ...providerConfig, ...patch }),
      provider_ref: undefined,
    })
  }

  const commitRuntimeConfig = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(runtimeText.trim() || '{}')
    } catch (e) {
      setRuntimeError(e instanceof Error ? e.message : String(e))
      return
    }
    if (!isPlainRecord(parsed)) {
      setRuntimeError('Runtime Config 必须是 JSON 对象')
      return
    }
    setRuntimeError('')
    setConfig({ runtime_config: parsed })
  }

  const selectedSkill = availableSkills.find((skill) => skill.id === selectedSkillId)
  const addSelectedSkill = () => {
    if (!selectedSkill) return
    setConfig({
      skills: addInlineSkillRef(skillRefs, selectedSkill),
      skill_names: undefined,
    })
    setSelectedSkillId('')
  }

  return (
    <>
      <div className="form-group">
        <label>指令（Instructions）</label>
        <textarea
          value={instructions}
          onChange={(e) => setConfig({ instructions: e.target.value })}
          placeholder="定义这个 Agent 的行为，例如：&#10;你是一个专业的学术写作助手，擅长：&#10;- 检查语法错误&#10;- 优化句子结构&#10;- 确保逻辑连贯"
          rows={6}
        />
        <div className="form-hint-sm">
          Agent 的核心指令，定义它的角色和能力。
        </div>
      </div>

      <div className="form-group">
        <label>Provider（此节点）</label>
        <select
          value={providerConfig.provider_id ?? ''}
          onChange={(e) => updateProviderConfig({ provider_id: e.target.value })}
          className={selectedProvider && selectedProvider.kind !== 'native' ? 'input-warning' : ''}
        >
          <option value="">— 未选择 Native Provider —</option>
          {selectedProvider &&
            selectedProvider.kind !== 'native' &&
            providerConfig.provider_id && (
              <option value={providerConfig.provider_id} disabled>
                {selectedProvider.name}（非 Native，不可用于临时 Agent）
              </option>
            )}
          {providerConfig.provider_id && !selectedProvider && (
            <option value={providerConfig.provider_id} disabled>
              缺失 Provider · {providerConfig.provider_id.slice(0, 8)}…
            </option>
          )}
          {nativeProviders.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {formatProviderOption(provider)}
            </option>
          ))}
        </select>
        {providerRef === 'workflow_default' && !providerConfig.provider_id ? (
          <div className="form-hint-sm form-hint-warning">
            旧 Workflow JSON 正在使用 Workflow 默认 Provider；选择后会迁移为节点级 Provider。
          </div>
        ) : (
          <div className="form-hint-sm">
            临时 Agent 使用自己的 Native Provider。不同节点可以选择不同 Provider。
          </div>
        )}
      </div>

      <div className="workflow-provider-grid">
        <div className="form-group">
          <label>Model</label>
          <select
            value={providerConfig.model ?? ''}
            onChange={(e) => updateProviderConfig({ model: e.target.value })}
            disabled={!selectedProvider && !providerConfig.model}
          >
            <option value="">使用 Provider 默认模型</option>
            {!selectedModelInOptions && providerConfig.model && (
              <option value={providerConfig.model}>当前已保存：{providerConfig.model}</option>
            )}
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {codexModelOptionLabel(model)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-group">
        <label>Skills</label>
        <div className="inline-skill-picker">
          <select
            value={selectedSkillId}
            onChange={(e) => setSelectedSkillId(e.target.value)}
            disabled={nativeLoading || availableSkills.length === 0}
          >
            <option value="">
              {nativeLoading
                ? '正在加载 Skill...'
                : availableSkills.length === 0
                  ? '没有可添加的 Skill'
                  : '选择本地 Skill'}
            </option>
            {availableSkills.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skillDisplayName(skill)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary-btn"
            onClick={addSelectedSkill}
            disabled={!selectedSkill}
          >
            添加
          </button>
        </div>
        {skillRefs.length > 0 ? (
          <div className="inline-skill-list">
            {skillRefs.map((ref, index) => {
              const sourceSkillId = ref.skill_id || ref.source_skill_id
              const skill = sourceSkillId ? skillsById.get(sourceSkillId) : undefined
              return (
                <InlineSkillRefRow
                  key={`${inlineSkillRefKey(ref)}:${index}`}
                  refConfig={ref}
                  skill={skill}
                  index={index}
                  onAliasChange={(alias) =>
                    setConfig({ skills: updateInlineSkillRefAlias(skillRefs, index, alias) })
                  }
                  onRemove={() =>
                    setConfig({
                      skills: removeInlineSkillRef(skillRefs, index),
                      skill_names: undefined,
                    })
                  }
                />
              )
            })}
          </div>
        ) : (
          <div className="form-readonly-list empty">尚未选择 Skill。</div>
        )}
        <div className="form-hint-sm">
          每个 Skill 会用 alias 投影到该节点的临时 workspace，避免同名模板互相覆盖。
        </div>
        <details className="inline-legacy-skill-editor">
          <summary>迁移旧 skill_names</summary>
          <input
            type="text"
            value={skillNames.join(', ')}
            onChange={(e) =>
              setConfig({
                skill_names: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="例如：latex-writing, academic-review"
          />
          <div className="form-hint-sm">
            仅用于旧 Workflow JSON；上方已选择 Skill 时执行端优先使用 skills[]。
          </div>
        </details>
      </div>

      <div className="form-group">
        <label>Runtime Config JSON</label>
        <textarea
          className={runtimeError ? 'input-warning' : ''}
          value={runtimeText}
          onChange={(e) => {
            setRuntimeText(e.target.value)
            if (runtimeError) setRuntimeError('')
          }}
          onBlur={commitRuntimeConfig}
          placeholder={'{\n  "mcp_server_ids": [],\n  "mcp_preset_ids": []\n}'}
          rows={6}
          spellCheck={false}
        />
        {runtimeError ? (
          <div className="form-hint-sm form-hint-warning">{runtimeError}</div>
        ) : (
          <div className="form-hint-sm">
            用于迁移 MCP server IDs、preset IDs 等 Native Agent 运行时配置。
          </div>
        )}
      </div>

      <div className="form-group">
        <label>额外提示词（可选）</label>
        <textarea
          value={additionalPrompt}
          onChange={(e) =>
            setConfig({ additional_prompt: e.target.value, promptHint: undefined })
          }
          placeholder="在 workflow 中给这个 agent 的额外指令，例如：&#10;- 你的输入来自上游节点的输出&#10;- 请输出 JSON 格式：{result, confidence}"
          rows={3}
        />
        <div className="form-hint-sm">
          节点级提示词，会注入到 agent 的系统提示中。
        </div>
      </div>

      <div className="form-group">
        <label className="form-label-inline">
          <input
            type="checkbox"
            checked={allowProjectContext}
            onChange={(e) =>
              setConfig({
                allow_project_context: e.target.checked,
                allowProjectContext: undefined,
              })
            }
          />
          允许读取项目文档
        </label>
        <div className="form-hint-sm">
          默认关闭。打开后，该节点可以在提示词明确要求时读取项目文档。
        </div>
      </div>

      <div className="form-hint-sm" style={{ marginTop: '12px', padding: '8px', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '6px', lineHeight: 1.6 }}>
        💡 <strong>Inline Agent 特性</strong>
        <br />· 配置完全存储在 Workflow JSON 中，支持跨项目迁移
        <br />· 不依赖团队中的预定义 Agent
        <br />· 每个节点使用自己的 Native Provider
        <br />· 适合需要独立配置的临时 Agent 场景
      </div>
    </>
  )
}

function InlineSkillRefRow({
  refConfig,
  skill,
  index,
  onAliasChange,
  onRemove,
}: {
  refConfig: InlineAgentSkillRef
  skill?: Skill
  index: number
  onAliasChange: (alias: string) => void
  onRemove: () => void
}) {
  return (
    <div className="inline-skill-row">
      <div className="inline-skill-main">
        <strong>{inlineSkillRefLabel(refConfig, skill)}</strong>
        <span>{inlineSkillRefSource(refConfig, skill)}</span>
      </div>
      <label className="inline-skill-alias">
        <span>alias</span>
        <input
          type="text"
          value={refConfig.alias}
          onChange={(e) => onAliasChange(e.target.value)}
          aria-label={`Skill ${index + 1} alias`}
        />
      </label>
      <button type="button" className="danger-btn inline-skill-remove" onClick={onRemove}>
        移除
      </button>
    </div>
  )
}

function skillDisplayName(skill: Skill): string {
  const label = skill.public_name || skill.name
  const source = skill.source === 'marketplace'
    ? '市场'
    : skill.source === 'project'
      ? '项目'
      : skill.source === 'template'
        ? '模板'
        : skill.visibility === 'public'
          ? '共享'
          : skill.visibility === 'system'
            ? '内置'
            : '私有'
  return `${label} · ${source}`
}

function inlineSkillRefLabel(ref: InlineAgentSkillRef, skill?: Skill): string {
  if (skill) return skill.public_name || skill.name
  if (ref.display_name) return ref.display_name
  if (ref.slug) return ref.namespace ? `${ref.namespace}/${ref.slug}` : ref.slug
  if (ref.release_id) return `Release ${ref.release_id.slice(0, 8)}`
  return ref.skill_id ? `Skill ${ref.skill_id.slice(0, 8)}` : 'Skill'
}

function inlineSkillRefSource(ref: InlineAgentSkillRef, skill?: Skill): string {
  if (ref.release_id) {
    const version = ref.version ? `@${ref.version}` : ''
    const namespace = ref.namespace && ref.slug ? `${ref.namespace}/${ref.slug}` : 'server release'
    return `${namespace}${version}`
  }
  if (skill) return skillDisplayName(skill).split(' · ').pop() || '本地 Skill'
  return ref.skill_id ? `本地 Skill · ${ref.skill_id.slice(0, 8)}` : '本地 Skill'
}

function formatProviderOption(provider: Provider): string {
  return provider.status === 'ok' ? provider.name : `${provider.name} · ${provider.status}`
}

function formatRuntimeConfigJson(value: unknown): string {
  const obj = isPlainRecord(value) ? value : {}
  return JSON.stringify(obj, null, 2)
}

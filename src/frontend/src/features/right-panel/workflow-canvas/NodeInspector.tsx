/**
 * NodeInspector — right-side config editor for the selected node.
 *
 * agent: agent_id (required for execution)
 * loop:  rounds (iteration count)
 */

import { useWorkflowStore } from '../../../stores/workflowStore'
import type { FlowNode, FlowNodeData } from './graphConversion'

interface NodeInspectorProps {
  node: FlowNode | null
  onUpdate: (id: string, patch: Partial<FlowNodeData>) => void
  onDelete: (id: string) => void
}

function formatAgentOption(name: string, id: string): string {
  const shortId = id.length > 10 ? `${id.slice(0, 8)}…` : id
  return `${name} · ${shortId}`
}

export function NodeInspector({ node, onUpdate, onDelete }: NodeInspectorProps) {
  const allWorkflows = useWorkflowStore((s) => s.workflows)
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
        <button className="danger-btn" onClick={() => onDelete(node.id)}>
          删除
        </button>
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
        const currentAgentId = (data.config.agent_id as string) ?? ''
        const activeAgents = allWorkflows.filter((w) => !w.is_disabled)
        const disabledAgents = allWorkflows.filter((w) => w.is_disabled)
        const selectedAgent = allWorkflows.find((w) => w.id === currentAgentId)
        const selectedIsDisabled = selectedAgent?.is_disabled ?? false
        const selectedIsOrphan = currentAgentId !== '' && !selectedAgent

        return (
          <>
            <div className="form-group">
              <label>Agent</label>
              <select
                value={currentAgentId}
                onChange={(e) => setConfig({ agent_id: e.target.value })}
                className={selectedIsDisabled || selectedIsOrphan ? 'input-warning' : ''}
              >
                <option value="">— 未选择 Agent —</option>
                {activeAgents.map((w) => (
                  <option key={w.id} value={w.id}>
                    {formatAgentOption(w.name, w.id)}
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
                        {formatAgentOption(w.name, w.id)}（已禁用）
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
                value={(data.config.additional_prompt as string) ?? ''}
                onChange={(e) => setConfig({ additional_prompt: e.target.value })}
                placeholder="在 workflow 中给这个 agent 的额外指令，例如：&#10;- 你的输入来自上游节点的输出&#10;- 请输出 JSON 格式：{result, confidence}&#10;- 保持简洁，不超过 100 字"
                rows={4}
              />
              <div className="form-hint-sm">
                节点级提示词，会注入到 agent 的系统提示中，告诉它在 workflow 中的角色和输出要求。
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
 *     {annotations,suggestions,risks} so the annotation panel can consume it.
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
          <option value="annotations">注释卡片（注释/建议/风险）</option>
        </select>
        <div className="form-hint-sm">
          注释卡片表示最终输出契约为 annotations / suggestions / risks。通过工作流入口运行时会自动进入批注列；聊天入口后续由用户手动转入批注列。
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

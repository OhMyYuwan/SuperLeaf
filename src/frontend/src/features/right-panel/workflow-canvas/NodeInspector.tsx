/**
 * NodeInspector — right-side config editor for the selected node.
 *
 * agent: agent_id (required for execution)
 * loop:  rounds (iteration count)
 */

import type { FlowNode, FlowNodeData } from './graphConversion'

interface NodeInspectorProps {
  node: FlowNode | null
  onUpdate: (id: string, patch: Partial<FlowNodeData>) => void
  onDelete: (id: string) => void
}

export function NodeInspector({ node, onUpdate, onDelete }: NodeInspectorProps) {
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
        <span>{data.nodeType === 'loop' ? 'Loop 容器' : 'Agent 节点'}</span>
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
          placeholder={data.nodeType === 'loop' ? 'Loop 标签' : 'Agent 标签'}
        />
      </div>

      {data.nodeType === 'agent' && (
        <div className="form-group">
          <label>Agent ID</label>
          <input
            type="text"
            value={(data.config.agent_id as string) ?? ''}
            onChange={(e) => setConfig({ agent_id: e.target.value })}
            placeholder="例如: reviewer / critic / polisher"
          />
          <div className="form-hint-sm">
            对应 Team 页注册的 Agent 名。多个上游输入会被自动拼接传入。
          </div>
        </div>
      )}

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
        </>
      )}
    </aside>
  )
}

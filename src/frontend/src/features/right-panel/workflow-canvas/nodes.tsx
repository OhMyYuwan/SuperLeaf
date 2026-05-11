/**
 * Custom node renderers for the workflow canvas.
 *
 * Node types:
 *   - input:  workflow entry. Exposes selection text, instruction, and
 *             @-referenced files to downstream nodes.
 *   - agent:  atomic execution unit. Multi-input merging happens naturally in
 *             the downstream agent's prompt; no dedicated merge node.
 *   - loop:   container. Agents / nested loops inside run for `rounds` iters.
 *   - output: workflow exit. Aggregates upstream outputs by `format`
 *             (text | json | annotations) and produces the run's final payload.
 */

import { memo } from 'react'
import { Handle, Position, useNodes, type NodeProps } from '@xyflow/react'
import { useWorkflowStore } from '../../../stores/workflowStore'
import type { FlowNode, FlowNodeData } from './graphConversion'

type Props = NodeProps<FlowNode>

function AgentCard({ data, selected }: Props) {
  const agentId = (data.config.agent_id as string) ?? ''
  const workflow = useWorkflowStore((s) =>
    agentId ? s.workflows.find((w) => w.id === agentId) : undefined,
  )

  const missing = agentId !== '' && !workflow
  const disabled = !!workflow?.is_disabled
  const unhealthy = missing || disabled
  const displayName = workflow?.name ?? (agentId || '未配置 agent')

  return (
    <div
      className={`wf-node wf-node-agent${selected ? ' selected' : ''}${
        unhealthy ? ' wf-node-disabled' : ''
      }`}
    >
      <div className="wf-node-head wf-head-agent">
        <span className="wf-node-icon">🤖</span>
        <span className="wf-node-kind">Agent</span>
        {disabled && <span className="wf-node-badge">已禁用</span>}
        {missing && <span className="wf-node-badge danger">缺失</span>}
      </div>
      <div className="wf-node-body">
        <div className="wf-node-label">{data.label || '未命名'}</div>
        <div className={`wf-node-config${agentId ? '' : ' missing'}`}>{displayName}</div>
      </div>
    </div>
  )
}

export const AgentNode = memo((props: Props) => (
  <>
    <Handle type="target" position={Position.Left} />
    <AgentCard {...props} />
    <Handle type="source" position={Position.Right} />
  </>
))
AgentNode.displayName = 'AgentNode'

/**
 * Input node. No target handle (it's the workflow entry). The body summarises
 * what will be fed into the graph so the user can see at a glance whether
 * instruction / files will reach downstream agents.
 */
export const InputNode = memo(({ data, selected }: Props) => {
  const includeInstruction = (data.config.include_instruction as boolean) ?? true
  const fileCount =
    Array.isArray(data.config.context_files)
      ? (data.config.context_files as unknown[]).length
      : 0
  return (
    <div className={`wf-node wf-node-input${selected ? ' selected' : ''}`}>
      <div className="wf-node-head wf-head-input">
        <span className="wf-node-icon">📥</span>
        <span className="wf-node-kind">Input</span>
      </div>
      <div className="wf-node-body">
        <div className="wf-node-label">{data.label || '工作流输入'}</div>
        <div className="wf-node-config">
          · 选中文本
          {includeInstruction && <br />}
          {includeInstruction && '· 用户指令'}
          {fileCount > 0 && (
            <>
              <br />· 引用文件 × {fileCount}
            </>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
})
InputNode.displayName = 'InputNode'

/**
 * Output node. No source handle (workflow exit). Displays the chosen format so
 * the user sees whether upstream results land as raw text, JSON, or annotation
 * cards in the right panel.
 */
export const OutputNode = memo(({ data, selected }: Props) => {
  const format = (data.config.format as string) ?? 'text'
  return (
    <div className={`wf-node wf-node-output${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-node-head wf-head-output">
        <span className="wf-node-icon">📤</span>
        <span className="wf-node-kind">Output</span>
      </div>
      <div className="wf-node-body">
        <div className="wf-node-label">{data.label || '工作流输出'}</div>
        <div className="wf-node-config">格式：{formatLabel(format)}</div>
      </div>
    </div>
  )
})
OutputNode.displayName = 'OutputNode'

function formatLabel(format: string): string {
  if (format === 'json') return 'JSON'
  if (format === 'annotations') return '注释结构'
  return '纯文本'
}

/**
 * Walk the parentId chain for every agent descendant of `loopId` and return the
 * count of unhealthy ones (disabled or missing agent reference).
 */
function countUnhealthyDescendants(
  loopId: string,
  nodes: FlowNode[],
  workflows: { id: string; is_disabled: boolean }[],
): number {
  const isDescendant = (n: FlowNode): boolean => {
    let cur: FlowNode | undefined = n
    while (cur?.parentId) {
      if (cur.parentId === loopId) return true
      cur = nodes.find((p) => p.id === cur!.parentId)
    }
    return false
  }

  let count = 0
  for (const n of nodes) {
    if (n.data.nodeType !== 'agent') continue
    if (!isDescendant(n)) continue
    const aid = (n.data.config.agent_id as string) ?? ''
    if (!aid) continue
    const hit = workflows.find((w) => w.id === aid)
    if (!hit || hit.is_disabled) count++
  }
  return count
}

/**
 * Loop container. Renders only a header band + dashed border; children (agents
 * or nested loops) are rendered by React Flow itself because they declare this
 * node as their `parentId`. React Flow handles layout/positioning.
 *
 * Width/height come from style (set by WorkflowCanvas on drop); we don't wrap
 * children in this component.
 */
export const LoopNode = memo(({ id, data, selected }: Props) => {
  const rounds = (data.config.rounds as number) ?? 3
  const allNodes = useNodes() as FlowNode[]
  const workflows = useWorkflowStore((s) => s.workflows)
  const unhealthyCount = countUnhealthyDescendants(id, allNodes, workflows)

  return (
    <div
      className={`wf-node-loop${selected ? ' selected' : ''}${
        unhealthyCount > 0 ? ' has-unhealthy' : ''
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-loop-header">
        <span className="wf-node-icon">🔁</span>
        <span className="wf-loop-title">{data.label || 'Loop'}</span>
        {unhealthyCount > 0 && (
          <span className="wf-node-badge danger" title="容器内有不可用节点">
            ⚠ {unhealthyCount}
          </span>
        )}
        <span className="wf-loop-rounds">× {rounds}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
})
LoopNode.displayName = 'LoopNode'

export const nodeTypes = {
  agent: AgentNode,
  loop: LoopNode,
  input: InputNode,
  output: OutputNode,
}

export type { FlowNodeData }

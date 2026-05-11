/**
 * Custom node renderers for the workflow canvas.
 *
 * Node types:
 *   - input:  workflow entry. Exposes selection text, instruction, and
 *             @-referenced files to downstream nodes.
 *   - agent:  atomic execution unit. Multi-input merging happens naturally in
 *             the downstream agent's prompt; no dedicated merge node.
 *   - loop:   container. Agents / nested loops inside run for `rounds` iters.
 *             Loop's input handle connects directly to internal agent input handles.
 *             Internal agent output handles connect directly to Loop's output handle.
 *             Loop output feeds back to Loop input for N iterations.
 *   - output: workflow exit. Aggregates upstream outputs by `format`
 *             (text | json | annotations) and produces the run's final payload.
 */

import { memo } from 'react'
import { Handle, Position, useNodes, useEdges, NodeResizer, type NodeProps } from '@xyflow/react'
import { useWorkflowStore } from '../../../stores/workflowStore'
import type { FlowNode, FlowNodeData } from './graphConversion'

type Props = NodeProps<FlowNode>

function AgentCard({ data, selected }: Props) {
  const agentId = (data.config.agent_id as string) ?? ''
  const loopOwner = (data.config._loop_owner as string) ?? ''
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
      }${loopOwner ? ' wf-node-in-loop' : ''}`}
    >
      <div className="wf-node-head wf-head-agent">
        <span className="wf-node-icon">🤖</span>
        <span className="wf-node-kind">Agent</span>
        {loopOwner && <span className="wf-node-badge loop-member" title={`属于 ${loopOwner}`}>🔁 {loopOwner}</span>}
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
      <Handle type="source" position={Position.Right} className="wf-boundary-handle" />
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
      <Handle type="target" position={Position.Left} className="wf-boundary-handle" />
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
 * Count unhealthy (disabled/missing) agents that belong to this loop via edges.
 * Internal membership: edge uses Loop's "loop-in-source" or "loop-out-target".
 *   - loop-in-source → X : X is the loop's first internal agent (Loop feeds it)
 *   - X → loop-out-target: X is the loop's last internal agent (feeds Loop)
 * External connections (loop-in-target, loop-out-source) do NOT create membership.
 */
function countUnhealthyMembers(
  loopId: string,
  nodes: FlowNode[],
  edges: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }[],
  workflows: { id: string; is_disabled: boolean }[],
): number {
  const memberIds = new Set<string>()
  for (const e of edges) {
    // Loop distributes to internal Agent: loop-in-source → Agent
    if (e.source === loopId && e.sourceHandle === 'loop-in-source') {
      memberIds.add(e.target)
    }
    // Internal Agent feeds back to Loop: Agent → loop-out-target
    if (e.target === loopId && e.targetHandle === 'loop-out-target') {
      memberIds.add(e.source)
    }
  }

  let count = 0
  for (const n of nodes) {
    if (n.data.nodeType !== 'agent') continue
    if (!memberIds.has(n.id)) continue
    const aid = (n.data.config.agent_id as string) ?? ''
    if (!aid) continue
    const hit = workflows.find((w) => w.id === aid)
    if (!hit || hit.is_disabled) count++
  }
  return count
}

/**
 * Loop container. Sits at zIndex: -1 as a background frame around its members.
 *
 * Each port has TWO handles overlapped at the same position:
 *   - Left port:
 *       "loop-in-target"  (target): external Agent → Loop (external connection)
 *       "loop-in-source"  (source): Loop → internal Agent (distributes to loop body)
 *   - Right port:
 *       "loop-out-target" (target): internal Agent → Loop (collects from loop body)
 *       "loop-out-source" (source): Loop → external Agent (final output)
 *
 * React Flow automatically routes a new edge to the correct handle based on
 * whether the user started the drag from a source or target, so the overlap
 * reads as one bidirectional port to the user.
 *
 * Membership rule (see WorkflowCanvas): an Agent is internal to this Loop iff
 * it's reachable forward from loop-in-source OR backward from loop-out-target.
 */
export const LoopNode = memo(({ id, data, selected }: Props) => {
  const rounds = (data.config.rounds as number) ?? 3
  const allNodes = useNodes() as FlowNode[]
  const allEdges = useEdges()
  const workflows = useWorkflowStore((s) => s.workflows)
  const unhealthyCount = countUnhealthyMembers(id, allNodes, allEdges, workflows)

  return (
    <div
      className={`wf-node-loop${selected ? ' selected' : ''}${
        unhealthyCount > 0 ? ' has-unhealthy' : ''
      }`}
    >
      <NodeResizer
        minWidth={280}
        minHeight={180}
        isVisible={selected}
        lineClassName="wf-loop-resizer-line"
        handleClassName="wf-loop-resizer-handle"
      />
      {/* Left port: one visual dot = two stacked handles.
          Drag FROM here = source (Loop distributes to internal Agent → membership).
          Drag INTO here = target (external Agent feeds Loop). */}
      <Handle
        id="loop-in-target"
        type="target"
        position={Position.Left}
        className="wf-loop-handle wf-loop-handle-in"
        title="Loop 输入端口（拖入 = 外部接入；拖出 = 分发到内部 Agent）"
      />
      <Handle
        id="loop-in-source"
        type="source"
        position={Position.Right}
        className="wf-loop-handle wf-loop-handle-in-source"
        title="Loop 输入端口（拖入 = 外部接入；拖出 = 分发到内部 Agent）"
      />
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
      {/* Right port: one visual dot = two stacked handles.
          Drag FROM here = source (Loop emits to external Agent).
          Drag INTO here = target (internal Agent feeds Loop output → membership). */}
      <Handle
        id="loop-out-target"
        type="target"
        position={Position.Left}
        className="wf-loop-handle wf-loop-handle-out-target"
        title="Loop 输出端口（拖入 = 内部 Agent 汇总；拖出 = 输出到外部 Agent）"
      />
      <Handle
        id="loop-out-source"
        type="source"
        position={Position.Right}
        className="wf-loop-handle wf-loop-handle-out"
        title="Loop 输出端口（拖入 = 内部 Agent 汇总；拖出 = 输出到外部 Agent）"
      />
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

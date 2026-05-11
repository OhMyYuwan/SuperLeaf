/**
 * Custom node renderers for the workflow canvas.
 *
 * Two types only:
 *   - agent: the atomic execution unit. Multiple inputs are merged naturally
 *            by the downstream agent (no separate merge node needed).
 *   - loop:  a container. Agents (and nested loops) dropped inside run for
 *            `rounds` iterations. Loops can nest arbitrarily deep.
 */

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FlowNode, FlowNodeData } from './graphConversion'

type Props = NodeProps<FlowNode>

function AgentCard({ data, selected }: Props) {
  const agentId = (data.config.agent_id as string) ?? ''
  return (
    <div className={`wf-node wf-node-agent${selected ? ' selected' : ''}`}>
      <div className="wf-node-head wf-head-agent">
        <span className="wf-node-icon">🤖</span>
        <span className="wf-node-kind">Agent</span>
      </div>
      <div className="wf-node-body">
        <div className="wf-node-label">{data.label || '未命名'}</div>
        <div className={`wf-node-config${agentId ? '' : ' missing'}`}>
          {agentId || '未配置 agent_id'}
        </div>
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
 * Loop container. Renders only a header band + dashed border; children (agents
 * or nested loops) are rendered by React Flow itself because they declare this
 * node as their `parentId`. React Flow handles layout/positioning.
 *
 * Width/height come from style (set by WorkflowCanvas on drop); we don't wrap
 * children in this component.
 */
export const LoopNode = memo(({ data, selected }: Props) => {
  const rounds = (data.config.rounds as number) ?? 3
  return (
    <div className={`wf-node-loop${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-loop-header">
        <span className="wf-node-icon">🔁</span>
        <span className="wf-loop-title">{data.label || 'Loop'}</span>
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
}

export type { FlowNodeData }

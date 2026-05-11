/**
 * Workflow definition health — derived from:
 *   1. boundary nodes (input + output required)
 *   2. agent node references (must be enabled CachedWorkflow)
 *
 *   ok       — has boundary nodes and every agent ref is healthy
 *   degraded — boundary present but at least one agent ref is disabled/missing
 *   missing  — input or output node absent (workflow is unrunnable)
 *   empty    — no agent nodes at all but boundaries are present (pass-through)
 *
 * Callers use this to grey out definition cards / disable the run button, and
 * to mark individual nodes in the canvas.
 */

import type { CachedWorkflow, WorkflowDefinition, WorkflowNode } from '../../../services/backendApi'

export type DefinitionHealth = 'ok' | 'degraded' | 'missing' | 'empty'

export interface NodeHealthIssue {
  nodeId: string
  agentId: string
  reason: 'disabled' | 'missing'
}

export interface DefinitionHealthReport {
  status: DefinitionHealth
  issues: NodeHealthIssue[]
  missingBoundary: Array<'input' | 'output'>
}

export function inspectAgentNode(
  node: WorkflowNode,
  workflows: CachedWorkflow[],
): NodeHealthIssue | null {
  if (node.type !== 'agent') return null
  const agentId = (node.config?.agent_id as string | undefined) ?? ''
  if (!agentId) return null
  const hit = workflows.find((w) => w.id === agentId)
  if (!hit) return { nodeId: node.id, agentId, reason: 'missing' }
  if (hit.is_disabled) return { nodeId: node.id, agentId, reason: 'disabled' }
  return null
}

export function inspectDefinition(
  def: Pick<WorkflowDefinition, 'graph'>,
  workflows: CachedWorkflow[],
): DefinitionHealthReport {
  const nodes = def.graph?.nodes ?? []
  const agentNodes = nodes.filter((n) => n.type === 'agent')

  const missingBoundary: Array<'input' | 'output'> = []
  if (!nodes.some((n) => n.type === 'input')) missingBoundary.push('input')
  if (!nodes.some((n) => n.type === 'output')) missingBoundary.push('output')

  const issues: NodeHealthIssue[] = []
  for (const n of agentNodes) {
    const issue = inspectAgentNode(n, workflows)
    if (issue) issues.push(issue)
  }

  if (missingBoundary.length > 0) {
    return { status: 'missing', issues, missingBoundary }
  }
  if (issues.length > 0) {
    return { status: 'degraded', issues, missingBoundary }
  }
  if (agentNodes.length === 0) {
    return { status: 'empty', issues, missingBoundary }
  }
  return { status: 'ok', issues, missingBoundary }
}

/**
 * Bidirectional conversion between backend WorkflowGraph and React Flow state.
 *
 * Loop membership is inferred from edges (an Agent connected to a Loop is a
 * member), so we don't need parentId/extent gymnastics. All nodes live at the
 * canvas root; Loop containers just render underneath with zIndex: -1.
 *
 * Layout data is stashed under `config._ui` so nothing leaks into the backend schema:
 *   - position:  {x, y}
 *   - size:      {width, height} (loop containers only)
 */

import type { Edge, Node } from '@xyflow/react'
import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from '../../../services/backendApi'

export type CanvasNodeType = 'agent' | 'loop' | 'input' | 'output'

export type FlowNodeData = {
  label: string
  nodeType: CanvasNodeType
  config: Record<string, unknown>
}

export type FlowNode = Node<FlowNodeData>

type UiMeta = {
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  parent_id?: string
}

const DEFAULT_POSITION = { x: 80, y: 80 }
const DEFAULT_LOOP_SIZE = { width: 360, height: 240 }

function readUi(config: Record<string, unknown>): UiMeta {
  return (config._ui as UiMeta | undefined) ?? {}
}

export function graphToFlow(graph: WorkflowGraph): {
  nodes: FlowNode[]
  edges: Edge[]
} {
  const nodes: FlowNode[] = graph.nodes.map((n, i) => {
    const config = normalizeNodeConfig(n.config ?? {})
    const ui = readUi(config)
    const position = ui.position ?? {
      x: DEFAULT_POSITION.x + (i % 3) * 220,
      y: DEFAULT_POSITION.y + Math.floor(i / 3) * 140,
    }
    const nodeType: CanvasNodeType =
      n.type === 'loop' ? 'loop'
      : n.type === 'input' ? 'input'
      : n.type === 'output' ? 'output'
      : 'agent'

    const flowNode: FlowNode = {
      id: n.id,
      type: nodeType,
      position,
      data: {
        label: n.label ?? n.id,
        nodeType,
        config,
      },
    }

    if (nodeType === 'loop') {
      const size = ui.size ?? DEFAULT_LOOP_SIZE
      flowNode.style = { width: size.width, height: size.height }
      flowNode.zIndex = -1
    }

    return flowNode
  })

  // Nodes-by-id lookup for the legacy-graph handle reconstruction below.
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))
  const parentOf = (id: string): string | undefined => {
    const n = nodesById.get(id)
    if (!n) return undefined
    const ui = readUi(n.config ?? {})
    return ui.parent_id
  }
  const isLoop = (id: string): boolean => nodesById.get(id)?.type === 'loop'

  const edges: Edge[] = graph.edges.map((e, i) => {
    // Prefer the stored handles; fall back to parent_id-based inference for
    // legacy graphs that pre-date the handle persistence (without this, all
    // Loop-touching edges collapse onto whichever handle React Flow picks
    // first, which is the user-reported "everything jumped to the left" bug).
    let sourceHandle = e.source_handle ?? null
    let targetHandle = e.target_handle ?? null
    if (!sourceHandle && isLoop(e.source)) {
      // Loop is the source of the edge. Is the target a member of THIS loop?
      sourceHandle = parentOf(e.target) === e.source ? 'loop-in-source' : 'loop-out-source'
    }
    if (!targetHandle && isLoop(e.target)) {
      // Loop is the target. Is the source a member of THIS loop?
      targetHandle = parentOf(e.source) === e.target ? 'loop-out-target' : 'loop-in-target'
    }

    return {
      id: `e-${i}-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      sourceHandle,
      targetHandle,
      label: e.condition,
      animated: true,
    }
  })

  return { nodes, edges }
}

export function flowToGraph(nodes: FlowNode[], edges: Edge[]): WorkflowGraph {
  // Re-derive loop membership from edge handles so the persisted graph carries
  // it explicitly via `_ui.parent_id` on each child. The canvas already keeps
  // a transient `_loop_owner` mirror, but we recompute here to stay decoupled
  // from canvas render order and to handle agents that haven't been touched by
  // the canvas memo yet (e.g. fresh graph save right after edge creation).
  //
  // Rules (same as WorkflowCanvas.loopMembership):
  //   - edge from Loop.loop-in-source → Agent : Agent is INTERNAL to Loop
  //   - edge from Agent → Loop.loop-out-target : Agent is INTERNAL to Loop
  //   - propagate via chain: any Agent reachable from a member via ordinary
  //     (non-Loop-handle) edges is also a member of the same Loop.
  const loopIds = new Set(
    nodes.filter((n) => n.data.nodeType === 'loop').map((n) => n.id),
  )
  const membership = new Map<string, string>()
  for (const e of edges) {
    if (loopIds.has(e.source) && e.sourceHandle === 'loop-in-source') {
      if (!loopIds.has(e.target)) membership.set(e.target, e.source)
    }
    if (loopIds.has(e.target) && e.targetHandle === 'loop-out-target') {
      if (!loopIds.has(e.source)) membership.set(e.source, e.target)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const e of edges) {
      if (loopIds.has(e.source) || loopIds.has(e.target)) continue
      const sL = membership.get(e.source)
      const tL = membership.get(e.target)
      if (sL && !tL) { membership.set(e.target, sL); changed = true }
      else if (tL && !sL) { membership.set(e.source, tL); changed = true }
    }
  }

  const outNodes: WorkflowNode[] = nodes.map((n) => {
    const config = normalizeNodeConfig(n.data.config ?? {})
    const ui: UiMeta = { position: n.position }
    if (n.data.nodeType === 'loop') {
      const w = typeof n.style?.width === 'number' ? n.style.width : DEFAULT_LOOP_SIZE.width
      const h = typeof n.style?.height === 'number' ? n.style.height : DEFAULT_LOOP_SIZE.height
      ui.size = { width: w, height: h }
    }
    const owner = membership.get(n.id)
    if (owner) ui.parent_id = owner
    config._ui = ui
    // Strip transient loop owner marker — recomputed from edges on load.
    delete config._loop_owner
    return {
      id: n.id,
      type: n.data.nodeType,
      label: n.data.label,
      config,
    }
  })

  const outEdges: WorkflowEdge[] = edges.map((e) => ({
    source: e.source,
    target: e.target,
    source_handle: e.sourceHandle ?? null,
    target_handle: e.targetHandle ?? null,
    condition: typeof e.label === 'string' ? e.label : undefined,
  }))

  return { nodes: outNodes, edges: outEdges }
}

function normalizeNodeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config }
  if (
    typeof next.additional_prompt !== 'string'
    && typeof next.promptHint === 'string'
    && next.promptHint.trim()
  ) {
    next.additional_prompt = next.promptHint
  }
  delete next.promptHint
  return next
}

export function generateNodeId(existing: FlowNode[], type: CanvasNodeType): string {
  const prefix =
    type === 'loop' ? 'L'
    : type === 'input' ? 'in'
    : type === 'output' ? 'out'
    : 'a'
  let i = existing.filter((n) => n.data.nodeType === type).length + 1
  while (existing.some((n) => n.id === `${prefix}${i}`)) i++
  return `${prefix}${i}`
}

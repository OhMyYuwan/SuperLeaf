/**
 * Bidirectional conversion between backend WorkflowGraph and React Flow state.
 *
 * Layout + container data is stashed under `config._ui` so nothing leaks into
 * the backend schema:
 *   - position:  {x, y}
 *   - parent_id: string (set when the node lives inside a loop container)
 *   - size:      {width, height} (loop containers only)
 *
 * The backend treats _ui as opaque and passes it through untouched.
 */

import type { Edge, Node } from '@xyflow/react'
import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from '../../../services/backendApi'

export type CanvasNodeType = 'agent' | 'loop'

export type FlowNodeData = {
  label: string
  nodeType: CanvasNodeType
  config: Record<string, unknown>
}

export type FlowNode = Node<FlowNodeData>

type UiMeta = {
  position?: { x: number; y: number }
  parent_id?: string
  size?: { width: number; height: number }
}

const DEFAULT_POSITION = { x: 80, y: 80 }
const DEFAULT_LOOP_SIZE = { width: 320, height: 200 }

function readUi(config: Record<string, unknown>): UiMeta {
  return (config._ui as UiMeta | undefined) ?? {}
}

export function graphToFlow(graph: WorkflowGraph): {
  nodes: FlowNode[]
  edges: Edge[]
} {
  // React Flow requires parents to come before children in the array, otherwise
  // the child nodes render at the wrong absolute position on first paint.
  const sortedNodes = [...graph.nodes].sort((a, b) => {
    const ap = readUi(a.config ?? {}).parent_id ? 1 : 0
    const bp = readUi(b.config ?? {}).parent_id ? 1 : 0
    return ap - bp
  })

  const nodes: FlowNode[] = sortedNodes.map((n, i) => {
    const config = { ...(n.config ?? {}) }
    const ui = readUi(config)
    const position = ui.position ?? {
      x: DEFAULT_POSITION.x + (i % 3) * 220,
      y: DEFAULT_POSITION.y + Math.floor(i / 3) * 140,
    }
    const nodeType: CanvasNodeType = n.type === 'loop' ? 'loop' : 'agent'

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

    if (ui.parent_id) {
      flowNode.parentId = ui.parent_id
      flowNode.extent = 'parent'
    }

    if (nodeType === 'loop') {
      const size = ui.size ?? DEFAULT_LOOP_SIZE
      flowNode.style = { width: size.width, height: size.height }
    }

    return flowNode
  })

  const edges: Edge[] = graph.edges.map((e, i) => ({
    id: `e-${i}-${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    label: e.condition,
    animated: true,
  }))

  return { nodes, edges }
}

export function flowToGraph(nodes: FlowNode[], edges: Edge[]): WorkflowGraph {
  const outNodes: WorkflowNode[] = nodes.map((n) => {
    const config = { ...(n.data.config ?? {}) }
    const ui: UiMeta = { position: n.position }
    if (n.parentId) ui.parent_id = n.parentId
    if (n.data.nodeType === 'loop') {
      const w = typeof n.style?.width === 'number' ? n.style.width : DEFAULT_LOOP_SIZE.width
      const h = typeof n.style?.height === 'number' ? n.style.height : DEFAULT_LOOP_SIZE.height
      ui.size = { width: w, height: h }
    }
    config._ui = ui
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
    condition: typeof e.label === 'string' ? e.label : undefined,
  }))

  return { nodes: outNodes, edges: outEdges }
}

export function generateNodeId(existing: FlowNode[], type: CanvasNodeType): string {
  const prefix = type === 'loop' ? 'L' : 'a'
  let i = existing.filter((n) => n.data.nodeType === type).length + 1
  while (existing.some((n) => n.id === `${prefix}${i}`)) i++
  return `${prefix}${i}`
}

/**
 * Given a drop point (already in flow coordinates), find the innermost loop
 * node whose bounding box contains the point. Returns undefined if the drop
 * happens on empty canvas.
 *
 * "Innermost" = deepest parent_id chain, so dropping into a nested loop
 * correctly attaches to the inner one, not the outer.
 */
export function findDropTarget(
  nodes: FlowNode[],
  point: { x: number; y: number },
): FlowNode | undefined {
  const loops = nodes.filter((n) => n.data.nodeType === 'loop')

  // Resolve absolute positions (parent position + child relative position).
  const absolutePos = (node: FlowNode): { x: number; y: number } => {
    if (!node.parentId) return node.position
    const parent = nodes.find((p) => p.id === node.parentId)
    if (!parent) return node.position
    const parentAbs = absolutePos(parent)
    return { x: parentAbs.x + node.position.x, y: parentAbs.y + node.position.y }
  }

  const hits = loops.filter((l) => {
    const abs = absolutePos(l)
    const w = (typeof l.style?.width === 'number' ? l.style.width : 0) || DEFAULT_LOOP_SIZE.width
    const h = (typeof l.style?.height === 'number' ? l.style.height : 0) || DEFAULT_LOOP_SIZE.height
    return (
      point.x >= abs.x &&
      point.x <= abs.x + w &&
      point.y >= abs.y &&
      point.y <= abs.y + h
    )
  })

  // Deepest (most nested) first.
  return hits.sort((a, b) => depth(b, nodes) - depth(a, nodes))[0]
}

function depth(node: FlowNode, nodes: FlowNode[]): number {
  let d = 0
  let cur: FlowNode | undefined = node
  while (cur?.parentId) {
    d++
    cur = nodes.find((n) => n.id === cur!.parentId)
  }
  return d
}

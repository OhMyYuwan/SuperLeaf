/**
 * WorkflowCanvas — React Flow editor for a WorkflowGraph.
 *
 * Key behaviors:
 *   - Loop containers sit at the bottom layer (zIndex: -1), never stealing
 *     focus from Agent nodes. Users don't drag Agents into loops.
 *   - Connection-based loop membership: when an Agent connects to a Loop's
 *     input or output handle, it's marked as belonging to that loop via
 *     `config._ui.loop_id`. Removing the connection unbinds it automatically.
 *   - Loop auto-resizes to visually encompass its member Agents.
 *   - Palette drop: places nodes at absolute canvas coords, no nesting logic.
 *   - Delete removes the node and any edges touching it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type OnConnect,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { WorkflowGraph } from '../../../services/backendApi'
import type { NodeStatus } from '../../../stores/workflowStore'
import { NodePalette } from './NodePalette'
import { NodeInspector } from './NodeInspector'
import { AgentNode, InputNode, LoopNode, OutputNode } from './nodes'
import {
  flowToGraph,
  generateNodeId,
  graphToFlow,
  type CanvasNodeType,
  type FlowNode,
  type FlowNodeData,
} from './graphConversion'

interface WorkflowCanvasProps {
  initialGraph: WorkflowGraph
  onGraphChange: (graph: WorkflowGraph) => void
  nodeStatuses?: NodeStatus[]
}

const LOOP_DEFAULT_SIZE = { width: 360, height: 240 }
const LOOP_PADDING = 40
const nodeTypes = {
  agent: AgentNode,
  loop: LoopNode,
  input: InputNode,
  output: OutputNode,
}

function CanvasInner({ initialGraph, onGraphChange, nodeStatuses = [] }: WorkflowCanvasProps) {
  const initial = useMemo(() => graphToFlow(initialGraph), [initialGraph])
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)
  const [inspectorId, setInspectorId] = useState<string | null>(null)
  const [paletteWidth, setPaletteWidth] = useState(200)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition, getNodes } = useReactFlow()

  useEffect(() => {
    onGraphChange(flowToGraph(nodes, edges))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  /**
   * Derive which Agents belong to which Loop based on directional edge handles.
   *
   * Internal membership rule (direction-sensitive):
   *   - Loop.loop-in-source → Agent.target : Agent is INSIDE the loop
   *     (Loop is feeding its input into the Agent)
   *   - Agent.source → Loop.loop-out-target : Agent is INSIDE the loop
   *     (Agent is feeding its output back into the Loop)
   *
   * External (not membership):
   *   - Agent.source → Loop.loop-in-target : external Agent feeds Loop from outside
   *   - Loop.loop-out-source → Agent.target : Loop feeds external Agent as final output
   *
   * Once an Agent is marked as a member, we also propagate to nested Agents
   * inside the loop (Agents chained off member Agents via ordinary edges).
   */
  const loopMembership = useMemo(() => {
    const membership = new Map<string, string>() // agentId -> loopId
    const loopIds = new Set(
      nodes.filter((n) => n.data.nodeType === 'loop').map((n) => n.id),
    )

    // Seed membership from direction-sensitive edges on Loop handles.
    for (const edge of edges) {
      if (loopIds.has(edge.source) && edge.sourceHandle === 'loop-in-source') {
        if (!loopIds.has(edge.target)) membership.set(edge.target, edge.source)
      }
      if (loopIds.has(edge.target) && edge.targetHandle === 'loop-out-target') {
        if (!loopIds.has(edge.source)) membership.set(edge.source, edge.target)
      }
    }

    // Propagate: any Agent reachable via ordinary edges from an existing
    // member (within the same connected internal chain) is also a member.
    let changed = true
    while (changed) {
      changed = false
      for (const edge of edges) {
        // Skip edges that touch a Loop directly — those were handled above.
        if (loopIds.has(edge.source) || loopIds.has(edge.target)) continue
        const srcLoop = membership.get(edge.source)
        const tgtLoop = membership.get(edge.target)
        if (srcLoop && !tgtLoop) {
          membership.set(edge.target, srcLoop)
          changed = true
        } else if (tgtLoop && !srcLoop) {
          membership.set(edge.source, tgtLoop)
          changed = true
        }
      }
    }

    return membership
  }, [nodes, edges])

  /**
   * Auto-resize Loop containers to encompass their member Agents.
   * Runs whenever membership or Agent positions change.
   */
  const nodesWithLoopSizing = useMemo(() => {
    const runStatusByNode = new Map(nodeStatuses.map((n) => [n.nodeId, n.status]))
    const agentBounds = new Map<string, { x: number; y: number; w: number; h: number }>()
    for (const n of nodes) {
      if (n.data.nodeType !== 'loop' && !n.parentId) {
        const w = typeof n.width === 'number' ? n.width : 180
        const h = typeof n.height === 'number' ? n.height : 80
        agentBounds.set(n.id, { x: n.position.x, y: n.position.y, w, h })
      }
    }

    return nodes.map((n) => {
      if (n.data.nodeType !== 'loop') {
        // Mark Agent with loop_id visually (for styling), store in data
        const ownerLoopId = loopMembership.get(n.id)
        const runStatus = runStatusByNode.get(n.id) ?? ''
        if (
          ownerLoopId !== (n.data.config._loop_owner as string | undefined) ||
          runStatus !== (n.data.config._run_status as string | undefined)
        ) {
          return {
            ...n,
            data: {
              ...n.data,
              config: { ...n.data.config, _loop_owner: ownerLoopId ?? '', _run_status: runStatus },
            },
          }
        }
        return n
      }

      // Loop node: compute bounding box of member agents
      const memberIds = [...loopMembership.entries()]
        .filter(([, loopId]) => loopId === n.id)
        .map(([agentId]) => agentId)

      if (memberIds.length === 0) {
        // No members — keep original size, but ensure loop stays at bottom
        return { ...n, zIndex: -1 }
      }

      const bounds = memberIds
        .map((id) => agentBounds.get(id))
        .filter((b): b is NonNullable<typeof b> => b !== undefined)

      if (bounds.length === 0) {
        return { ...n, zIndex: -1 }
      }

      const minX = Math.min(...bounds.map((b) => b.x)) - LOOP_PADDING
      const minY = Math.min(...bounds.map((b) => b.y)) - LOOP_PADDING - 30 // extra for header
      const maxX = Math.max(...bounds.map((b) => b.x + b.w)) + LOOP_PADDING
      const maxY = Math.max(...bounds.map((b) => b.y + b.h)) + LOOP_PADDING

      return {
        ...n,
        position: { x: minX, y: minY },
        style: {
          ...n.style,
          width: Math.max(LOOP_DEFAULT_SIZE.width, maxX - minX),
          height: Math.max(LOOP_DEFAULT_SIZE.height, maxY - minY),
        },
        zIndex: -1,
      }
    })
  }, [nodes, loopMembership, nodeStatuses])

  const onConnect: OnConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params, animated: true }, eds)),
    [setEdges],
  )

  /**
   * Dragging a Loop translates its member Agents with it. Without this, the
   * `nodesWithLoopSizing` memo recomputes the Loop's position from the
   * unchanged member bounds every frame and snaps it back to where it was.
   *
   * At drag start we snapshot the Loop's start position and each member's
   * start position; during drag we apply the total delta to every member so
   * the Loop's recomputed bounds follow the cursor naturally.
   */
  const dragSyncRef = useRef<{
    loopId: string
    startLoopPos: { x: number; y: number }
    startMemberPositions: Map<string, { x: number; y: number }>
  } | null>(null)

  const onNodeDragStart = useCallback(
    (_: unknown, node: FlowNode) => {
      if (node.type !== 'loop') {
        dragSyncRef.current = null
        return
      }
      const memberIds = [...loopMembership.entries()]
        .filter(([, loopId]) => loopId === node.id)
        .map(([agentId]) => agentId)
      if (memberIds.length === 0) {
        dragSyncRef.current = null
        return
      }
      const currentNodes = getNodes() as FlowNode[]
      const startMemberPositions = new Map<string, { x: number; y: number }>()
      for (const m of memberIds) {
        const found = currentNodes.find((n) => n.id === m)
        if (found) startMemberPositions.set(m, { ...found.position })
      }
      dragSyncRef.current = {
        loopId: node.id,
        startLoopPos: { ...node.position },
        startMemberPositions,
      }
    },
    [loopMembership, getNodes],
  )

  const onNodeDrag = useCallback(
    (_: unknown, node: FlowNode) => {
      const state = dragSyncRef.current
      if (!state || state.loopId !== node.id) return
      const dx = node.position.x - state.startLoopPos.x
      const dy = node.position.y - state.startLoopPos.y
      setNodes((nds) =>
        nds.map((n) => {
          const start = state.startMemberPositions.get(n.id)
          if (!start) return n
          return { ...n, position: { x: start.x + dx, y: start.y + dy } }
        }),
      )
    },
    [setNodes],
  )

  const onNodeDragStop = useCallback(() => {
    dragSyncRef.current = null
  }, [])

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      const droppedType = event.dataTransfer.getData('application/reactflow') as CanvasNodeType | 'inline-agent' | ''
      if (
        droppedType !== 'agent' &&
        droppedType !== 'inline-agent' &&
        droppedType !== 'loop' &&
        droppedType !== 'input' &&
        droppedType !== 'output'
      )
        return
      const nodeType: CanvasNodeType = droppedType === 'inline-agent' ? 'agent' : droppedType
      const isInlineAgent = droppedType === 'inline-agent'

      const currentNodes = getNodes() as FlowNode[]

      // Input / output nodes are workflow boundaries — only one of each.
      if (nodeType === 'input' && currentNodes.some((n) => n.data.nodeType === 'input')) {
        console.warn('[workflow-canvas] input node already exists, ignoring drop')
        return
      }
      if (nodeType === 'output' && currentNodes.some((n) => n.data.nodeType === 'output')) {
        console.warn('[workflow-canvas] output node already exists, ignoring drop')
        return
      }

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })

      setNodes((nds) => {
        const id = generateNodeId(nds, nodeType)
        const defaultConfig: Record<string, unknown> =
          nodeType === 'loop' ? { rounds: 3 }
          : nodeType === 'input' ? {
              include_instruction: true,
              context_files: [],
              extra_inputs: {},
            }
          : nodeType === 'output' ? { format: 'text', source_node_ids: [] }
          : isInlineAgent ? {
              agent_source: 'inline',
              inline_agent: true,
              skill_names: [],
              instructions: '',
              runtime_config: {},
              provider_ref: 'workflow_default',
              additional_prompt: '',
              allow_project_context: false,
            }
          : { agent_source: 'team' }
        const defaultLabel =
          nodeType === 'loop' ? 'Loop'
          : nodeType === 'input' ? 'Input'
          : nodeType === 'output' ? 'Output'
          : isInlineAgent ? 'Inline Agent'
          : id
        const newNode: FlowNode = {
          id,
          type: nodeType,
          position,
          data: {
            label: defaultLabel,
            nodeType,
            config: defaultConfig,
          },
          ...(nodeType === 'loop'
            ? { style: { ...LOOP_DEFAULT_SIZE }, zIndex: -1 }
            : {}),
        }
        return nds.concat(newNode)
      })
    },
    [screenToFlowPosition, getNodes, setNodes],
  )

  const inspectorNode = nodes.find((n) => n.id === inspectorId) ?? null

  const updateNodeData = useCallback(
    (id: string, patch: Partial<FlowNodeData>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? {
                ...n,
                data: { ...n.data, ...patch, config: { ...n.data.config, ...(patch.config ?? {}) } },
              }
            : n,
        ),
      )
    },
    [setNodes],
  )

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id))
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
      setInspectorId(null)
    },
    [setNodes, setEdges],
  )

  const startPaletteResize = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = paletteWidth
    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.max(56, Math.min(260, startWidth + moveEvent.clientX - startX))
      setPaletteWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [paletteWidth])

  return (
    <div
      className={`wf-canvas-root${inspectorNode ? ' has-inspector' : ''}`}
      style={{ '--wf-palette-width': `${paletteWidth}px` } as CSSProperties}
    >
      <NodePalette compact={paletteWidth < 108} />
      <div className="wf-palette-resizer" onMouseDown={startPaletteResize} title="拖动调整节点桶宽度" />
      <div className="wf-canvas-wrapper" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
        <ReactFlow
          nodes={nodesWithLoopSizing}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeDoubleClick={(_, node) => {
            setInspectorId(node.id)
          }}
          onPaneClick={() => {
            setInspectorId(null)
          }}
          nodeTypes={nodeTypes}
          fitView
          deleteKeyCode={['Backspace', 'Delete']}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      {inspectorNode && (
        <NodeInspector
          node={inspectorNode}
          onUpdate={updateNodeData}
          onDelete={deleteNode}
          onClose={() => setInspectorId(null)}
        />
      )}
    </div>
  )
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

/**
 * WorkflowCanvas — React Flow editor for a WorkflowGraph.
 *
 * Key behaviors:
 *   - Palette drop: detects which (possibly nested) loop contains the drop point
 *     and sets parentId accordingly. Agents dropped inside a loop become its
 *     children; a loop dropped inside another loop nests.
 *   - Parent-child positions are relative to the parent, so we convert drop
 *     point → flow coords → parent-relative coords.
 *   - Loops expand to fit children via expandParent on the children.
 *   - Delete removes the node and any edges touching it; deleting a loop also
 *     removes its children recursively.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Background,
  Controls,
  MiniMap,
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
import { NodePalette } from './NodePalette'
import { NodeInspector } from './NodeInspector'
import { nodeTypes } from './nodes'
import {
  findDropTarget,
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
}

const LOOP_DEFAULT_SIZE = { width: 320, height: 200 }

function CanvasInner({ initialGraph, onGraphChange }: WorkflowCanvasProps) {
  const initial = useMemo(() => graphToFlow(initialGraph), [initialGraph])
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition, getNodes } = useReactFlow()

  useEffect(() => {
    onGraphChange(flowToGraph(nodes, edges))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  const onConnect: OnConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params, animated: true }, eds)),
    [setEdges],
  )

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      const nodeType = event.dataTransfer.getData('application/reactflow') as CanvasNodeType | ''
      if (nodeType !== 'agent' && nodeType !== 'loop') return

      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const currentNodes = getNodes() as FlowNode[]
      const dropParent = findDropTarget(currentNodes, flowPoint)

      // React Flow stores child position relative to parent. Convert absolute
      // flow coords into parent-relative if the drop lands inside a loop.
      let position = flowPoint
      if (dropParent) {
        const parentAbs = absolutePosition(currentNodes, dropParent.id)
        position = {
          x: flowPoint.x - parentAbs.x,
          y: flowPoint.y - parentAbs.y,
        }
      }

      setNodes((nds) => {
        const id = generateNodeId(nds, nodeType)
        const newNode: FlowNode = {
          id,
          type: nodeType,
          position,
          data: {
            label: nodeType === 'loop' ? 'Loop' : id,
            nodeType,
            config: nodeType === 'loop' ? { rounds: 3 } : {},
          },
          ...(dropParent
            ? { parentId: dropParent.id, extent: 'parent' as const, expandParent: true }
            : {}),
          ...(nodeType === 'loop'
            ? { style: { ...LOOP_DEFAULT_SIZE } }
            : {}),
        }
        return nds.concat(newNode)
      })
    },
    [screenToFlowPosition, getNodes, setNodes],
  )

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null

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
      setNodes((nds) => {
        // Remove the node itself plus any descendants (recursive via parentId chain).
        const toRemove = new Set<string>([id])
        let grew = true
        while (grew) {
          grew = false
          for (const n of nds) {
            if (n.parentId && toRemove.has(n.parentId) && !toRemove.has(n.id)) {
              toRemove.add(n.id)
              grew = true
            }
          }
        }
        return nds.filter((n) => !toRemove.has(n.id))
      })
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
      setSelectedId(null)
    },
    [setNodes, setEdges],
  )

  return (
    <div className="wf-canvas-root">
      <NodePalette />
      <div className="wf-canvas-wrapper" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          nodeTypes={nodeTypes}
          fitView
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <NodeInspector node={selectedNode} onUpdate={updateNodeData} onDelete={deleteNode} />
    </div>
  )
}

function absolutePosition(nodes: FlowNode[], id: string): { x: number; y: number } {
  const node = nodes.find((n) => n.id === id)
  if (!node) return { x: 0, y: 0 }
  if (!node.parentId) return node.position
  const parent = absolutePosition(nodes, node.parentId)
  return { x: parent.x + node.position.x, y: parent.y + node.position.y }
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

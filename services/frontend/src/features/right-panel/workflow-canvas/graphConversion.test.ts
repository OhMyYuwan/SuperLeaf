import { describe, expect, it } from 'vitest'
import type { WorkflowGraph } from '../../../services/backendApi'
import { flowToGraph, generateNodeId, graphToFlow, type FlowNode } from './graphConversion'

describe('workflow graph conversion inline Agent normalization', () => {
  it('loads legacy inline-agent nodes as inline Agent UI nodes', () => {
    const graph: WorkflowGraph = {
      nodes: [
        {
          id: 'ia1',
          type: 'inline-agent',
          label: 'Draft',
          config: { instructions: 'Draft text', _ui: { position: { x: 12, y: 34 } } },
        },
      ],
      edges: [],
    }

    const flow = graphToFlow(graph)

    expect(flow.nodes[0].type).toBe('agent')
    expect(flow.nodes[0].data.nodeType).toBe('agent')
    expect(flow.nodes[0].data.config.agent_source).toBe('inline')
    expect(flow.nodes[0].data.config.inline_agent).toBe(true)
  })

  it('persists temporary Agents as agent nodes with inline source config', () => {
    const node: FlowNode = {
      id: 'a1',
      type: 'agent',
      position: { x: 10, y: 20 },
      data: {
        label: 'Temporary Agent',
        nodeType: 'agent',
        config: {
          agent_source: 'inline',
          inline_agent: true,
          instructions: 'Draft text',
        },
      },
    }

    const graph = flowToGraph([node], [])
    const savedNode = graph.nodes[0]!

    expect(savedNode.type).toBe('agent')
    expect(savedNode.config!.agent_source).toBe('inline')
    expect(savedNode.config!.inline_agent).toBe(true)
    expect(savedNode.config!.provider).toEqual({})
    expect(savedNode.config!.provider_ref).toBeUndefined()
  })

  it('generates normal agent IDs for temporary Agent nodes', () => {
    expect(generateNodeId([], 'agent')).toBe('a1')
  })
})

import type { NanobotToolDefinition } from './backendApi'
import registryJson from '../../../shared/superleaf-tools.json'

interface SuperleafRegistryTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface SuperleafToolRegistry {
  id?: string
  version?: number
  instructions?: {
    mcp?: string[]
  }
  examples?: {
    listDocsMarker?: string
    readDocMarker?: string
  }
  tools: SuperleafRegistryTool[]
}

export const SUPERLEAF_TOOL_REGISTRY = registryJson as SuperleafToolRegistry

export const SUPERLEAF_TOOL_MARKER_EXAMPLES = {
  listDocs:
    SUPERLEAF_TOOL_REGISTRY.examples?.listDocsMarker ||
    '<superleaf_tool_call>{"name":"project_list_docs","arguments":{}}</superleaf_tool_call>',
  readDoc:
    SUPERLEAF_TOOL_REGISTRY.examples?.readDocMarker ||
    '<superleaf_tool_call>{"name":"project_read_doc","arguments":{"doc_id":"..."}}</superleaf_tool_call>',
}

interface ToolGuideOptions {
  markerExample?: string
}

export function superleafRegistryAsToolDefinitions(): NanobotToolDefinition[] {
  return SUPERLEAF_TOOL_REGISTRY.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }))
}

export function formatSuperleafToolDefinitions(
  tools: NanobotToolDefinition[],
  options: ToolGuideOptions = {},
): string {
  const rendered = normalizeTools(tools).map((tool) => {
    const fn = tool.function
    return [
      `- ${fn.name}`,
      fn.description ? `  description: ${fn.description}` : '',
      `  arguments_schema: ${JSON.stringify(fn.parameters ?? { type: 'object', properties: {} })}`,
    ].filter(Boolean).join('\n')
  })
  return [
    'These tools are available through SuperLeaf browser/backend authorization.',
    'Never say these tools are not mounted, unavailable, or only available in another SuperLeaf chat window.',
    'Do not use your own local filesystem or shell as a substitute for SuperLeaf project/document tools.',
    'If native MCP/function tools are available, call the SuperLeaf tool directly.',
    'If direct tool calls are not available in this API channel, request exactly one fallback marker and no prose.',
    'Use standard ASCII JSON double quotes and include the closing tag:',
    options.markerExample || SUPERLEAF_TOOL_MARKER_EXAMPLES.listDocs,
    'Use propose_doc_edit for normal document changes; it creates an approval proposal, not an applied edit.',
    'Use create_suggestion only when the user explicitly asks for an annotation, comment, or suggestion card.',
    'Available schemas:',
    ...rendered,
  ].join('\n')
}

export function formatCompactSuperleafToolGuide(
  tools: NanobotToolDefinition[],
  options: ToolGuideOptions = {},
): string {
  const rendered = normalizeTools(tools).map((tool) => {
    const fn = tool.function
    const params = fn.parameters ?? {}
    const required = Array.isArray(params.required) ? params.required.map(String) : []
    const props = params.properties && typeof params.properties === 'object'
      ? Object.keys(params.properties)
      : []
    const args = required.length > 0
      ? `required: ${required.join(', ')}`
      : props.length > 0
        ? `args: ${props.join(', ')}`
        : 'args: none'
    return `- ${fn.name} (${args})`
  })
  return [
    'SuperLeaf tools are available through browser/backend authorization.',
    'Never say these tools are unavailable or only available in another SuperLeaf chat window.',
    'If native MCP/function tools are available, call the SuperLeaf tool directly.',
    'Otherwise request exactly one fallback marker with standard ASCII JSON double quotes and the closing tag:',
    options.markerExample || SUPERLEAF_TOOL_MARKER_EXAMPLES.readDoc,
    'Do not use local filesystem reads as a substitute for SuperLeaf project/document tools.',
    'Use propose_doc_edit for normal document changes; it creates an approval proposal, not an applied edit.',
    'Use create_suggestion only for explicit annotation/comment/suggestion-card requests.',
    ...rendered,
  ].join('\n')
}

function normalizeTools(tools: NanobotToolDefinition[]): NanobotToolDefinition[] {
  return tools.length > 0 ? tools : superleafRegistryAsToolDefinitions()
}

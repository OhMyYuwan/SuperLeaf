import type { NanobotToolDefinition } from './backendApi'

const DEFAULT_LIST_DOCS_MARKER =
  '<superleaf_tool_call>{"name":"project_list_docs","arguments":{}}</superleaf_tool_call>'
const DEFAULT_READ_DOC_MARKER =
  '<superleaf_tool_call>{"name":"project_read_doc","arguments":{"doc_id":"..."}}</superleaf_tool_call>'

interface ToolGuideOptions {
  markerExample?: string
}

export function formatSuperleafToolDefinitions(
  tools: NanobotToolDefinition[],
  options: ToolGuideOptions = {},
): string {
  const rendered = tools.map((tool) => {
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
    options.markerExample || DEFAULT_LIST_DOCS_MARKER,
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
  const rendered = tools.map((tool) => {
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
    options.markerExample || DEFAULT_READ_DOC_MARKER,
    'Do not use local filesystem reads as a substitute for SuperLeaf project/document tools.',
    'Use propose_doc_edit for normal document changes; it creates an approval proposal, not an applied edit.',
    'Use create_suggestion only for explicit annotation/comment/suggestion-card requests.',
    ...rendered,
  ].join('\n')
}

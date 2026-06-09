import type {
  BrowserCodexPrepare,
  BrowserNanobotToolResult,
  ProviderDraft,
} from './backendApi'
import {
  buildSuperleafFallbackToolGuide,
  shouldIncludeSuperleafToolGuide,
  toolGuideModeForTransport,
} from './agentToolGuidePolicy'
import { formatSuperleafToolDefinitions } from './superleafTools'

export type SuperLeafContextMode = 'legacy-blocks' | 'lease'
export const SUPERLEAF_SESSION_BOOT_VERSION = 'superleaf-boot@1'

export interface CodexPromptPolicyArgs {
  prepared: BrowserCodexPrepare
  toolResults: BrowserNanobotToolResult[]
  contextId?: string
  includeSessionBoot?: boolean
}

export interface CodexSessionBootState {
  superleaf_boot_version?: string
}

export function buildCodexPromptWithPolicy(args: CodexPromptPolicyArgs): string {
  const { prepared, toolResults, contextId, includeSessionBoot = false } = args
  if (prepared.prompt_mode === 'full-agent') {
    return buildFullCodexPrompt(prepared, toolResults)
  }
  if (shouldUseCodexLeasePrompt(prepared, contextId)) {
    return buildLeaseCodexPrompt(prepared, toolResults, contextId || '', includeSessionBoot)
  }
  return buildLegacyFastCodexPrompt(prepared, toolResults)
}

export function shouldUseCodexLeasePrompt(
  prepared: BrowserCodexPrepare,
  contextId?: string,
): boolean {
  return (
    prepared.prompt_mode === 'fast-edit' &&
    codexContextMode(prepared) === 'lease' &&
    codexToolMode(prepared) !== 'marker-only' &&
    Boolean(contextId || stringValue(prepared.superleaf_context.context_id))
  )
}

export function codexContextMode(prepared: BrowserCodexPrepare): SuperLeafContextMode {
  const value =
    stringSetting(prepared.codex_settings?.context_mode) ||
    stringSetting(prepared.codex_settings?.codex_context_mode) ||
    stringSetting(prepared.superleaf_context.context_mode)
  return value === 'legacy-blocks' ? 'legacy-blocks' : 'lease'
}

export function codexToolMode(prepared: BrowserCodexPrepare): NonNullable<ProviderDraft['codex_tool_mode']> {
  const value = stringSetting(prepared.codex_settings?.tool_mode)
  return isOneOf(value, ['mcp-first', 'browser-preflight', 'marker-only'])
    ? value as NonNullable<ProviderDraft['codex_tool_mode']>
    : 'mcp-first'
}

export function codexEffectiveApprovalPolicy(
  prepared: BrowserCodexPrepare,
): NonNullable<ProviderDraft['codex_approval_policy']> {
  const value = stringSetting(prepared.codex_settings?.approval_policy)
  const configured = isOneOf(value, ['never', 'untrusted', 'on-request', 'on-failure'])
    ? value as NonNullable<ProviderDraft['codex_approval_policy']>
    : 'on-request'
  if (configured === 'never' && codexToolMode(prepared) !== 'marker-only') {
    return 'on-request'
  }
  return configured
}

export function shouldIncludeCodexSessionBoot(
  prepared: BrowserCodexPrepare,
  session: CodexSessionBootState | null | undefined,
): boolean {
  return (
    prepared.prompt_mode === 'fast-edit' &&
    codexContextMode(prepared) === 'lease' &&
    codexToolMode(prepared) !== 'marker-only' &&
    stringValue(session?.superleaf_boot_version) !== SUPERLEAF_SESSION_BOOT_VERSION
  )
}

export function buildLegacyFastCodexPrompt(
  prepared: BrowserCodexPrepare,
  toolResults: BrowserNanobotToolResult[],
): string {
  const sections: string[] = [
    [
      '[SUPERLEAF FAST MODE]',
      'You are local Codex inside the SuperLeaf editor.',
      'Stay concise. Preserve SuperLeaf as the editing and collaboration UI.',
      codexToolModePrompt(prepared),
      'For selected-text rewrites, request propose_doc_edit instead of telling the user to edit manually.',
      'Do not claim edits are applied; SuperLeaf shows proposal cards for user approval.',
      '[END SUPERLEAF FAST MODE]',
    ].join('\n'),
  ]
  const guideMode = toolGuideModeForTransport(codexToolMode(prepared))
  if (prepared.tools.length > 0 && shouldIncludeSuperleafToolGuide(guideMode)) {
    sections.push(`[SUPERLEAF TOOL GUIDE]\n${buildSuperleafFallbackToolGuide(prepared.tools)}`)
  }
  appendToolResults(sections, toolResults, 'Use the tool results above. If more project reads are necessary, request additional tool markers as needed.')
  sections.push(prepared.prompt)
  return sections.join('\n\n')
}

export function buildLeaseCodexPrompt(
  prepared: BrowserCodexPrepare,
  toolResults: BrowserNanobotToolResult[],
  contextId: string,
  includeSessionBoot = false,
): string {
  const sections: string[] = [buildSuperLeafTurnHeader(prepared, contextId)]
  if (includeSessionBoot) sections.push(buildCodexSessionBootBlock(prepared))
  appendToolResults(sections, toolResults, 'Use the tool results above. If more SuperLeaf context is needed, request another MCP tool call using this context_id.')
  sections.push(prepared.prompt)
  return sections.join('\n\n')
}

export function buildCodexSessionBootBlock(prepared: BrowserCodexPrepare): string {
  return [
    '[SUPERLEAF SESSION BOOT]',
    `version: ${SUPERLEAF_SESSION_BOOT_VERSION}`,
    'You are local Codex inside the SuperLeaf editor.',
    'Keep turns concise and preserve SuperLeaf as the editing and collaboration UI.',
    codexToolModePrompt(prepared),
    'Use SuperLeaf MCP tools for project reads, document search, suggestions, edit proposals, annotations, and safe project file creation.',
    'For selected-text rewrites, call propose_doc_edit; do not claim text was applied unless a tool result confirms it.',
    '[END SUPERLEAF SESSION BOOT]',
  ].join('\n')
}

export function buildSuperLeafTurnHeader(
  prepared: BrowserCodexPrepare,
  contextId: string,
): string {
  const ctx = prepared.superleaf_context || {}
  const lines = [
    '[SUPERLEAF TURN]',
    `context_id: ${contextId || stringValue(ctx.context_id) || 'unregistered'}`,
    'context_mode: lease',
    'mode: fast-edit',
    'tool_surface: codex-local',
    `tool_transport: ${codexToolMode(prepared)}`,
    `doc_id: ${prepared.document_id}`,
    `range: ${prepared.range_start}-${prepared.range_end}`,
  ]
  const docName = stringValue(ctx.document_name)
  const docFormat = stringValue(ctx.document_format)
  const selectionHash = stringValue(ctx.selection_hash)
  const contextChanged = stringValue(ctx.context_changed) || 'unknown'
  const manifestVersion = stringValue(ctx.tool_manifest_version)
  const docVersion = stringValue(ctx.doc_version)
  const contextHash = stringValue(ctx.context_hash)
  const selectionPreview = headerValue(ctx.selection_preview, 240)
  if (docName) lines.push(`doc_name: ${docName}`)
  if (docFormat) lines.push(`doc_format: ${docFormat}`)
  if (docVersion) lines.push(`doc_version: ${headerValue(docVersion, 120)}`)
  if (contextHash) lines.push(`context_hash: ${contextHash}`)
  if (selectionHash) lines.push(`selection_hash: ${selectionHash}`)
  if (manifestVersion) lines.push(`tool_manifest_version: ${manifestVersion}`)
  lines.push(`changed: ${contextChanged}`)
  if (selectionPreview && contextChanged !== 'none') {
    lines.push(`selection_preview: ${selectionPreview}`)
  }
  lines.push('[/SUPERLEAF TURN]')
  return lines.join('\n')
}

function buildFullCodexPrompt(
  prepared: BrowserCodexPrepare,
  toolResults: BrowserNanobotToolResult[],
): string {
  const sections: string[] = []
  if (prepared.system_prompt.trim()) {
    sections.push(`[SUPERLEAF INSTRUCTIONS]\n${prepared.system_prompt.trim()}`)
  }
  sections.push(`[SUPERLEAF TOOL MODE]\n${codexToolModePrompt(prepared)}`)
  if (prepared.tools.length > 0) {
    sections.push(`[AVAILABLE SUPERLEAF TOOLS]\n${formatSuperleafToolDefinitions(prepared.tools)}`)
  }
  appendToolResults(
    sections,
    toolResults,
    [
      'Use the tool results above to answer the user.',
      'If more SuperLeaf project context is needed, request additional SuperLeaf tool call markers as needed.',
      'Do not repeat a tool call whose result is already shown unless the user asks or the result is insufficient.',
    ].join(' '),
  )
  sections.push(`[CURRENT USER MESSAGE]\n${prepared.prompt}`)
  return sections.join('\n\n')
}

function appendToolResults(
  sections: string[],
  toolResults: BrowserNanobotToolResult[],
  instruction: string,
): void {
  if (toolResults.length === 0) return
  sections.push(`[SUPERLEAF TOOL RESULTS]\n${formatToolResults(toolResults)}`)
  sections.push(instruction)
}

function formatToolResults(results: BrowserNanobotToolResult[]): string {
  return results
    .map((result, idx) => [
      `Tool result ${idx + 1}: ${result.name || 'tool'}`,
      `tool_call_id: ${result.tool_call_id}`,
      `failed: ${result.failed ? 'true' : 'false'}`,
      'content:',
      result.content ?? '',
    ].join('\n'))
    .join('\n\n')
}

function codexToolModePrompt(prepared: BrowserCodexPrepare): string {
  const mode = codexToolMode(prepared)
  if (mode === 'browser-preflight') {
    return 'SuperLeaf may pre-execute obvious read-only document tools through the browser before the Codex turn; use those results first. For new tool needs, prefer direct SuperLeaf MCP when available.'
  }
  if (mode === 'marker-only') {
    return 'SuperLeaf direct MCP is disabled for this provider. Request SuperLeaf tools only by emitting the fallback marker format exactly.'
  }
  return 'SuperLeaf MCP is the primary tool channel. Prefer direct SuperLeaf MCP tools over fallback markers; the browser bridge executes those tools with the current SuperLeaf login context.'
}

function stringSetting(value: unknown): string {
  return stringValue(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function headerValue(value: unknown, limit: number): string {
  const text = stringValue(value).replace(/\s+/gu, ' ')
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 3))}...`
}

function isOneOf(value: string, allowed: string[]): boolean {
  return allowed.includes(value)
}

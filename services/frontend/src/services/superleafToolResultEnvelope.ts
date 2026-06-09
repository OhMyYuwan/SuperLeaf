import type { BrowserNanobotToolResult } from './backendApi'

export interface SuperLeafToolResultEnvelopeFields {
  model_visible: Record<string, unknown>
  ui_meta: Record<string, unknown>
  audit: Record<string, unknown>
}

export function normalizeBrowserToolResultForAgent(
  result: BrowserNanobotToolResult,
): BrowserNanobotToolResult {
  const modelVisible = objectValue(result.model_visible) || legacyModelVisible(result)
  const uiMeta = objectValue(result.ui_meta) || legacyUiMeta(result)
  const audit = objectValue(result.audit) || legacyAudit(result)
  return {
    ...result,
    content: modelVisibleContent(result, modelVisible),
    model_visible: modelVisible,
    ui_meta: uiMeta,
    audit,
  }
}

export function toolResultEnvelopeFields(
  result: BrowserNanobotToolResult,
): SuperLeafToolResultEnvelopeFields {
  const normalized = normalizeBrowserToolResultForAgent(result)
  return {
    model_visible: normalized.model_visible ?? {},
    ui_meta: normalized.ui_meta ?? {},
    audit: normalized.audit ?? {},
  }
}

function modelVisibleContent(
  result: BrowserNanobotToolResult,
  modelVisible: Record<string, unknown>,
): string {
  if (result.failed) return result.content
  const directContent = stringValue(modelVisible.content)
  if (directContent) return directContent
  if (Object.keys(modelVisible).length > 0) return JSON.stringify(modelVisible)
  return result.content
}

function legacyModelVisible(result: BrowserNanobotToolResult): Record<string, unknown> {
  if (result.failed) {
    return {
      status: 'error',
      tool_name: result.name,
      summary: result.content,
    }
  }
  const sideEvent = legacySideEvent(result)
  if (sideEvent?.event === 'ylw.msg.edit_proposal') {
    const data = objectValue(sideEvent.data) || {}
    return {
      status: 'ok',
      tool_name: result.name,
      summary: 'Edit proposal created in SuperLeaf and is waiting for user approval.',
      next_instruction: 'Briefly explain the proposed change and do not claim it was applied.',
      proposal_id: stringValue(data.proposal_id),
      document_id: stringValue(data.document_id),
    }
  }
  if (sideEvent?.event === 'ylw.msg.suggestion_created') {
    const data = objectValue(sideEvent.data) || {}
    return {
      status: 'ok',
      tool_name: result.name,
      summary: 'Suggestion annotation created in SuperLeaf.',
      next_instruction: 'Briefly mention that the annotation card is available in SuperLeaf.',
      suggestion_id: stringValue(data.suggestion_id),
      document_id: stringValue(data.document_id),
    }
  }
  return {
    status: 'ok',
    tool_name: result.name,
    content: result.content,
  }
}

function legacyUiMeta(result: BrowserNanobotToolResult): Record<string, unknown> {
  const sideEvent = legacySideEvent(result)
  const meta: Record<string, unknown> = {
    tool_name: result.name,
    tool_kind: result.tool_kind,
    failed: result.failed,
  }
  if (sideEvent) {
    meta.side_event = {
      event: sideEvent.event,
      data: objectValue(sideEvent.data) || {},
    }
  }
  return meta
}

function legacyAudit(result: BrowserNanobotToolResult): Record<string, unknown> {
  return {
    tool_call_id: result.tool_call_id,
    tool_name: result.name,
    tool_kind: result.tool_kind,
    failed: result.failed,
    has_side_event: Boolean(legacySideEvent(result)),
  }
}

function legacySideEvent(
  result: BrowserNanobotToolResult,
): { event: string; data: unknown } | null {
  return result.events.find((evt) =>
    evt.event === 'ylw.msg.edit_proposal' ||
    evt.event === 'ylw.msg.suggestion_created' ||
    evt.event === 'native.agent.project_file_created'
  ) ?? null
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

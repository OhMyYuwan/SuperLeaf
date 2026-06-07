import type { BrowserCodexPrepare } from './backendApi'

export type SuperLeafContextChange = 'none' | 'selection' | 'document' | 'tools'

export interface CodexDeltaContextSnapshot {
  documentId: string
  docVersion: string
  rangeStart: number
  rangeEnd: number
  selectionHash: string
  toolManifestVersion: string
  contextHash: string
}

export interface CodexDeltaContextResult {
  prepared: BrowserCodexPrepare
  snapshot: CodexDeltaContextSnapshot
  changed: SuperLeafContextChange
}

export function applyCodexDeltaContext(
  prepared: BrowserCodexPrepare,
  previous?: CodexDeltaContextSnapshot,
): CodexDeltaContextResult {
  const snapshot = buildCodexDeltaContextSnapshot(prepared)
  const changed = compareCodexDeltaContext(previous, snapshot)
  return {
    prepared: withCodexContextDelta(prepared, snapshot, changed),
    snapshot,
    changed,
  }
}

export function forceCodexDeltaContextUnchanged(
  prepared: BrowserCodexPrepare,
): BrowserCodexPrepare {
  const snapshot = buildCodexDeltaContextSnapshot(prepared)
  const contextHash = stringValue(prepared.superleaf_context.context_hash) || snapshot.contextHash
  return {
    ...prepared,
    superleaf_context: {
      ...prepared.superleaf_context,
      context_hash: contextHash,
      context_changed: 'none',
    },
  }
}

export function buildCodexDeltaContextSnapshot(
  prepared: BrowserCodexPrepare,
): CodexDeltaContextSnapshot {
  const ctx = prepared.superleaf_context || {}
  const documentId = stringValue(ctx.document_id) || prepared.document_id
  const docVersion = stringValue(ctx.doc_version)
  const rangeStart = numberValue(ctx.range_start, prepared.range_start)
  const rangeEnd = numberValue(ctx.range_end, prepared.range_end)
  const selectionHash = stringValue(ctx.selection_hash)
  const toolManifestVersion = stringValue(ctx.tool_manifest_version)
  const contextHash = hashStableContext([
    documentId,
    docVersion,
    String(rangeStart),
    String(rangeEnd),
    selectionHash,
    toolManifestVersion,
  ])
  return {
    documentId,
    docVersion,
    rangeStart,
    rangeEnd,
    selectionHash,
    toolManifestVersion,
    contextHash,
  }
}

export function compareCodexDeltaContext(
  previous: CodexDeltaContextSnapshot | undefined,
  current: CodexDeltaContextSnapshot,
): SuperLeafContextChange {
  if (!previous) return current.selectionHash ? 'selection' : 'document'
  if (
    previous.documentId !== current.documentId ||
    previous.docVersion !== current.docVersion
  ) {
    return 'document'
  }
  if (previous.toolManifestVersion !== current.toolManifestVersion) return 'tools'
  if (
    previous.rangeStart !== current.rangeStart ||
    previous.rangeEnd !== current.rangeEnd ||
    previous.selectionHash !== current.selectionHash
  ) {
    return 'selection'
  }
  return 'none'
}

function withCodexContextDelta(
  prepared: BrowserCodexPrepare,
  snapshot: CodexDeltaContextSnapshot,
  changed: SuperLeafContextChange,
): BrowserCodexPrepare {
  return {
    ...prepared,
    superleaf_context: {
      ...prepared.superleaf_context,
      context_hash: snapshot.contextHash,
      context_changed: changed,
    },
  }
}

function hashStableContext(parts: string[]): string {
  const value = parts.join('\u001f')
  let hash = 0x811c9dc5
  for (let idx = 0; idx < value.length; idx += 1) {
    hash ^= value.charCodeAt(idx)
    hash = Math.imul(hash, 0x01000193)
  }
  return `slctxh_${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown, fallback: number): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

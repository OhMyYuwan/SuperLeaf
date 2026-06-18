/**
 * ProjectEventBridge — bridges the SSE stream from /api/projects/{id}/events
 * into the relevant zustand stores. Mounted once inside WorkspacePage so its
 * lifetime matches "user is working in some project".
 *
 * Events that arrive here have already been filtered for self-echo (the
 * stream drops events whose origin_client_id matches our own); we just need
 * to dispatch into the right store with the apply-only writers that don't
 * loop back to the backend.
 */

import { useEffect } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useUserStore } from '../../stores/userStore'
import {
  useAnnotationStore,
  type AgentEvaluation,
  type AnnotationItem,
  type CardKind,
  type CardStatus,
  type ReviewStatus,
} from '../../stores/annotationStore'
import { useAnnotationAgentSuggestionStore } from '../../stores/annotationAgentSuggestionStore'
import { useDocumentStore } from '../../stores/documentStore'
import { useCollaborationStore } from '../../stores/collaborationStore'
import {
  useFilesystemStore,
  type ProjectTreeChangePayload,
} from '../../stores/filesystemStore'
import type { AnnotationDto } from '../../services/annotationEvaluationApi'
import { projectEventStream, type ProjectEvent } from '../../services/projectEventStream'

let treeReloadTimer: ReturnType<typeof setTimeout> | null = null
let lastProjectEventSeq: number | null = null

export function ProjectEventBridge() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const currentUserId = useUserStore((s) => s.currentUser?.id ?? '')

  useEffect(() => {
    if (!currentProjectId) {
      projectEventStream.stop()
      clearScheduledTreeReload()
      resetProjectEventSeq()
      return
    }
    resetProjectEventSeq()
    projectEventStream.start(currentProjectId, (evt: ProjectEvent) => {
      try {
        dispatchProjectEvent(evt, currentUserId)
      } catch (err) {
        console.warn('[event-bridge] failed to apply event', evt.type, err)
      }
    })
    return () => {
      projectEventStream.stop()
      clearScheduledTreeReload()
      resetProjectEventSeq()
    }
  }, [currentProjectId, currentUserId])

  return null
}

export function dispatchProjectEvent(evt: ProjectEvent, currentUserId: string): void {
  const p = evt.payload as Record<string, unknown>
  if (hasProjectEventSeqGap(evt)) {
    scheduleTreeReload()
  }

  // Agent-private events: skip if the annotation is private and belongs to another user.
  // Special case: if an annotation.updated event makes a previously-global annotation
  // private (unpublished), we need to REMOVE it from the local store.
  if (evt.type.startsWith('annotation.')) {
    const ann = p.annotation as Record<string, unknown> | undefined
    const evtIsGlobal = ann?.is_global ?? p.is_global ?? false
    const evtUserId = String(ann?.user_id ?? p.user_id ?? '')
    const isOtherUser = evtUserId && currentUserId && evtUserId !== currentUserId
    if (!evtIsGlobal && isOtherUser) {
      // If this is an update that made the annotation private, remove it locally
      if (evt.type === 'annotation.updated' && ann?.id) {
        useAnnotationStore.getState().applyRemoteAnnotationDelete(String(ann.id))
      }
      return
    }
  }

  switch (evt.type) {
    case 'annotation.review_status.changed': {
      const aid = String(p.annotation_id ?? '')
      const status = String(p.status ?? '') as ReviewStatus
      if (!aid || !status) return
      useAnnotationStore.getState().applyRemoteReviewStatus(aid, status)
      return
    }
    case 'annotation.evaluation.created':
    case 'annotation.evaluation.updated': {
      const aid = String(p.annotation_id ?? '')
      const raw = p.evaluation as Record<string, unknown> | undefined
      if (!aid || !raw) return
      const ev: AgentEvaluation = {
        id: String(raw.id),
        annotationId: String(raw.annotation_id ?? aid),
        targetType: raw.target_type as AgentEvaluation['targetType'],
        targetId: String(raw.target_id ?? ''),
        verdict: raw.verdict as AgentEvaluation['verdict'],
        reason: String(raw.reason ?? ''),
        tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
        adoption: raw.adoption as AgentEvaluation['adoption'],
        trainingCandidate: Boolean(raw.training_candidate),
        context: (raw.context as Record<string, unknown>) ?? {},
        createdAt: String(raw.created_at ?? new Date().toISOString()),
        updatedAt: String(raw.updated_at ?? new Date().toISOString()),
      }
      useAnnotationStore.getState().applyRemoteEvaluationUpsert(aid, ev)
      return
    }
    case 'annotation.evaluation.deleted': {
      const aid = String(p.annotation_id ?? '')
      const eid = String(p.evaluation_id ?? '')
      if (!aid || !eid) return
      useAnnotationStore.getState().applyRemoteEvaluationDelete(aid, eid)
      return
    }
    case 'annotation.created':
    case 'annotation.updated': {
      const raw = p.annotation as AnnotationDto | undefined
      if (!raw || !raw.id) return
      const incoming = annotationFromDto(raw)
      const annotationState = useAnnotationStore.getState()
      const collabDocId = useCollaborationStore.getState().currentDocId
      if (
        evt.type === 'annotation.updated' &&
        collabDocId === incoming.documentId &&
        isRangeOnlyAnnotationUpdate(annotationState.items[incoming.id], incoming)
      ) {
        return
      }
      annotationState.applyRemoteAnnotationUpsert(incoming)
      if (raw.doc_id) void useAnnotationAgentSuggestionStore.getState().hydrateForDoc(raw.doc_id)
      return
    }
    case 'annotation.deleted': {
      const aid = String(p.annotation_id ?? '')
      if (!aid) return
      useAnnotationStore.getState().applyRemoteAnnotationDelete(aid)
      const docId = String(p.doc_id ?? '')
      if (docId) void useAnnotationAgentSuggestionStore.getState().hydrateForDoc(docId)
      return
    }
    case 'doc.updated': {
      const docId = String(p.doc_id ?? '')
      if (!docId) return
      // In collaboration mode, Yjs handles document sync — skip REST refresh.
      const collabDocId = useCollaborationStore.getState().currentDocId
      if (collabDocId === docId) return
      // refreshFromBackend is dirty-aware: if the user is mid-edit it skips
      // and the next focus refresh picks it up. So this is safe to fire on
      // every server-side save.
      void useDocumentStore.getState().refreshFromBackend(docId)
      return
    }
    case 'project.tree.changed': {
      const applied = useFilesystemStore.getState().applyRemoteTreeChange(p as ProjectTreeChangePayload)
      if (!applied) scheduleTreeReload()
      return
    }
    default:
      // Unknown event types are ignored; the server may add more.
      return
  }
}

export function isRangeOnlyAnnotationUpdate(
  current: AnnotationItem | undefined,
  incoming: AnnotationItem,
): boolean {
  if (!current) return false
  const rangeChanged =
    current.range.from !== incoming.range.from || current.range.to !== incoming.range.to
  if (!rangeChanged) return false
  return (
    current.id === incoming.id &&
    current.documentId === incoming.documentId &&
    current.userId === incoming.userId &&
    current.isGlobal === incoming.isGlobal &&
    current.workflowId === incoming.workflowId &&
    current.agentName === incoming.agentName &&
    current.kind === incoming.kind &&
    current.status === incoming.status &&
    current.targetText === incoming.targetText &&
    current.content === incoming.content &&
    current.severity === incoming.severity &&
    (current.original ?? '') === (incoming.original ?? '') &&
    (current.proposed ?? '') === (incoming.proposed ?? '') &&
    (current.reason ?? '') === (incoming.reason ?? '') &&
    (current.riskType ?? '') === (incoming.riskType ?? '') &&
    (current.mitigation ?? '') === (incoming.mitigation ?? '') &&
    (current.conversationId ?? '') === (incoming.conversationId ?? '') &&
    JSON.stringify(current.thread) === JSON.stringify(incoming.thread) &&
    JSON.stringify(current.attachedFiles ?? []) === JSON.stringify(incoming.attachedFiles ?? [])
  )
}

function scheduleTreeReload(): void {
  if (treeReloadTimer) clearTimeout(treeReloadTimer)
  treeReloadTimer = setTimeout(() => {
    treeReloadTimer = null
    void useFilesystemStore.getState().loadTree()
  }, 150)
}

function clearScheduledTreeReload(): void {
  if (!treeReloadTimer) return
  clearTimeout(treeReloadTimer)
  treeReloadTimer = null
}

function resetProjectEventSeq(): void {
  lastProjectEventSeq = null
}

function hasProjectEventSeqGap(evt: ProjectEvent): boolean {
  if (typeof evt.seq !== 'number') return false
  const previous = lastProjectEventSeq
  lastProjectEventSeq = previous === null ? evt.seq : Math.max(previous, evt.seq)
  return previous !== null && evt.seq > previous + 1
}

function annotationFromDto(d: AnnotationDto): AnnotationItem {
  return {
    id: d.id,
    documentId: d.doc_id,
    userId: d.user_id ?? '',
    isGlobal: d.is_global ?? false,
    workflowId: d.workflow_id,
    agentName: d.agent_name,
    kind: d.kind as CardKind,
    status: d.status as CardStatus,
    range: { from: d.range_from, to: d.range_to },
    targetText: d.target_text,
    content: d.content,
    severity: d.severity,
    original: d.original || undefined,
    proposed: d.proposed || undefined,
    reason: d.reason || undefined,
    riskType: (d.risk_type || undefined) as AnnotationItem['riskType'],
    mitigation: d.mitigation || undefined,
    conversationId: d.conversation_id || undefined,
    thread: (d.thread ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: new Date(m.created_at),
      agentId: m.agent_id ?? undefined,
      agentName: m.agent_name ?? undefined,
    })),
    attachedFiles: d.attached_files && d.attached_files.length > 0
      ? (d.attached_files as unknown as AnnotationItem['attachedFiles'])
      : undefined,
    createdAt: new Date(d.created_at),
  }
}

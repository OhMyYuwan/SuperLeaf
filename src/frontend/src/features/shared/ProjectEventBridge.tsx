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
import {
  useAnnotationStore,
  type AgentEvaluation,
  type AnnotationItem,
  type CardKind,
  type CardStatus,
  type ReviewStatus,
} from '../../stores/annotationStore'
import { useDocumentStore } from '../../stores/documentStore'
import type { AnnotationDto } from '../../services/annotationEvaluationApi'
import { projectEventStream, type ProjectEvent } from '../../services/projectEventStream'

export function ProjectEventBridge() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId)

  useEffect(() => {
    if (!currentProjectId) {
      projectEventStream.stop()
      return
    }
    projectEventStream.start(currentProjectId, (evt: ProjectEvent) => {
      try {
        dispatch(evt)
      } catch (err) {
        console.warn('[event-bridge] failed to apply event', evt.type, err)
      }
    })
    return () => {
      projectEventStream.stop()
    }
  }, [currentProjectId])

  return null
}

function dispatch(evt: ProjectEvent): void {
  const p = evt.payload as Record<string, unknown>
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
      useAnnotationStore.getState().applyRemoteAnnotationUpsert(annotationFromDto(raw))
      return
    }
    case 'annotation.deleted': {
      const aid = String(p.annotation_id ?? '')
      if (!aid) return
      useAnnotationStore.getState().applyRemoteAnnotationDelete(aid)
      return
    }
    case 'doc.updated': {
      const docId = String(p.doc_id ?? '')
      if (!docId) return
      // refreshFromBackend is dirty-aware: if the user is mid-edit it skips
      // and the next focus refresh picks it up. So this is safe to fire on
      // every server-side save.
      void useDocumentStore.getState().refreshFromBackend(docId)
      return
    }
    default:
      // Unknown event types are ignored; the server may add more.
      return
  }
}

function annotationFromDto(d: AnnotationDto): AnnotationItem {
  return {
    id: d.id,
    documentId: d.doc_id,
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

import { describe, expect, it } from 'vitest'
import {
  buildFrontendPermissionEvidenceMatrix,
} from './permission-policy.mjs'

describe('frontend materialized permission evidence matrix', () => {
  it('covers browser bridge and project event privacy entrypoints', () => {
    const matrix = buildFrontendPermissionEvidenceMatrix()
    const keys = matrix.map((row) => `${row.entrypoint}:${row.policyId}`).sort()

    expect(keys).toEqual([
      'browser-bridge:approval-poll',
      'browser-bridge:approval-result',
      'browser-bridge:context-register',
      'browser-bridge:endpoint-normalize',
      'browser-bridge:tool-poll',
      'browser-bridge:tool-result',
      'project-event:annotation-private-event',
    ])

    for (const row of matrix) {
      expect(row.entrypoint).toMatch(/^(browser-bridge|project-event)$/)
      expect(row.resource).toBeTruthy()
      expect(row.action).toBeTruthy()
      expect(row.subjectBinding).toBeTruthy()
      expect(row.ownerBoundary).toBeTruthy()
      expect(row.runtimeGuards.length).toBeGreaterThan(0)
      expect(row.behaviorEvidence.length).toBeGreaterThan(0)
    }
  })

  it('records resource ownership boundaries for frontend bridge secrets', () => {
    const matrix = buildFrontendPermissionEvidenceMatrix()
    const toolResult = matrix.find((row) => row.policyId === 'tool-result')
    const approvalPoll = matrix.find((row) => row.policyId === 'approval-poll')
    const eventPrivacy = matrix.find((row) => row.policyId === 'annotation-private-event')

    expect(toolResult?.subjectBinding).toBe('browser-local-token+context-secret+request-lease')
    expect(toolResult?.ownerBoundary).toBe('active-browser-bridge-request')
    expect(toolResult?.runtimeGuards).toContain('lease-secret-submit')
    expect(approvalPoll?.runtimeGuards).toContain('active-resource-binding-validation')
    expect(eventPrivacy?.ownerBoundary).toBe('current-user-private-annotations-or-global-events')
    expect(eventPrivacy?.runtimeGuards).toContain('drop-other-user-private-annotation-events')
  })
})

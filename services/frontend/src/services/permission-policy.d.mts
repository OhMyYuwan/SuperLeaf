export interface FrontendPermissionBehaviorEvidence {
  testModule: string
  evidence: string
}

export interface FrontendPermissionEvidenceRow {
  entrypoint: 'browser-bridge' | 'project-event'
  policyId: string
  surface: string
  resource: string
  action: string
  subjectBinding: string
  ownerBoundary: string
  runtimeGuards: string[]
  behaviorEvidence: FrontendPermissionBehaviorEvidence[]
}

export const FRONTEND_PERMISSION_EVIDENCE_ROWS: FrontendPermissionEvidenceRow[]

export function buildFrontendPermissionEvidenceMatrix(): FrontendPermissionEvidenceRow[]

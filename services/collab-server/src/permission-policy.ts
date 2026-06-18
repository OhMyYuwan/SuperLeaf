import {
  COLLAB_HTTP_ROUTE_POLICIES,
  COLLAB_HTTP_ROUTE_TEST_POLICIES,
  type CollabHttpRoutePolicy,
  type CollabHttpRouteTestPolicy,
} from './persistence.js'
import {
  COLLAB_WS_UPGRADE_POLICIES,
  COLLAB_WS_UPGRADE_TEST_POLICIES,
  type CollabWsUpgradePolicy,
  type CollabWsUpgradeTestPolicy,
} from './upgrade-auth.js'

export type CollabPermissionEntrypoint = 'http' | 'websocket'

export interface CollabPermissionBehaviorEvidence {
  testModule: string
  evidence: string
  notes?: string
}

export interface CollabServerPermissionEvidenceRow {
  entrypoint: CollabPermissionEntrypoint
  routeId: string
  method: string
  path: string
  authSurface: string
  resource: string
  action: string
  subjectBinding: string
  ownerBoundary: string
  runtimeGuards: readonly string[]
  behaviorEvidence: readonly CollabPermissionBehaviorEvidence[]
  notes?: string
}

export function buildCollabServerPermissionEvidenceMatrix(options: {
  httpPolicies?: readonly CollabHttpRoutePolicy[]
  httpCoverage?: readonly CollabHttpRouteTestPolicy[]
  wsPolicies?: readonly CollabWsUpgradePolicy[]
  wsCoverage?: readonly CollabWsUpgradeTestPolicy[]
} = {}): readonly CollabServerPermissionEvidenceRow[] {
  const httpPolicies = options.httpPolicies ?? COLLAB_HTTP_ROUTE_POLICIES
  const httpCoverage = options.httpCoverage ?? COLLAB_HTTP_ROUTE_TEST_POLICIES
  const wsPolicies = options.wsPolicies ?? COLLAB_WS_UPGRADE_POLICIES
  const wsCoverage = options.wsCoverage ?? COLLAB_WS_UPGRADE_TEST_POLICIES

  return [
    ...httpPolicies.map((policy) => {
      return {
        entrypoint: 'http' as const,
        routeId: policy.routeId,
        method: policy.method.toUpperCase(),
        path: policy.path,
        authSurface: policy.authSurface,
        resource: policy.resource,
        action: policy.action,
        subjectBinding: collabHttpSubjectBinding(policy),
        ownerBoundary: collabHttpOwnerBoundary(policy),
        runtimeGuards: collabHttpRuntimeGuards(policy),
        behaviorEvidence: behaviorEvidenceForRoute(policy.routeId, httpCoverage),
        notes: policy.notes,
      }
    }),
    ...wsPolicies.map((policy) => {
      return {
        entrypoint: 'websocket' as const,
        routeId: policy.routeId,
        method: 'UPGRADE',
        path: policy.path,
        authSurface: policy.authSurface,
        resource: policy.resource,
        action: policy.action,
        subjectBinding: 'backend-verified-user-doc',
        ownerBoundary: 'backend-doc-membership',
        runtimeGuards: collabWsRuntimeGuards(policy),
        behaviorEvidence: behaviorEvidenceForRoute(policy.routeId, wsCoverage),
      }
    }),
  ]
}

function collabHttpSubjectBinding(policy: CollabHttpRoutePolicy): string {
  return policy.authSurface === 'public'
    ? 'anonymous-public'
    : 'backend-internal-token'
}

function collabHttpOwnerBoundary(policy: CollabHttpRoutePolicy): string {
  return policy.authSurface === 'public'
    ? 'public-health-metadata'
    : 'backend-authorized-doc'
}

function collabHttpRuntimeGuards(policy: CollabHttpRoutePolicy): readonly string[] {
  if (policy.authSurface === 'public') {
    return ['public-health-only']
  }
  return [
    'collab-internal-token',
    'timing-safe-token-compare',
    'historical-default-token-disabled',
  ]
}

function collabWsRuntimeGuards(policy: CollabWsUpgradePolicy): readonly string[] {
  const guards = [
    'collab-token-subprotocol',
    'backend-doc-id-verifier',
  ]
  if (policy.requiresGenerationCheck) {
    guards.push('collab-generation-check')
  }
  if (policy.requiresMessageReauth) {
    guards.push('message-time-reauth')
  }
  return guards
}

function behaviorEvidenceForRoute(
  routeId: string,
  coverage: readonly (CollabHttpRouteTestPolicy | CollabWsUpgradeTestPolicy)[],
): readonly CollabPermissionBehaviorEvidence[] {
  return coverage
    .filter((policy) => policy.routeId === routeId)
    .map((policy) => {
      return {
        testModule: policy.testModule,
        evidence: policy.evidence,
        notes: policy.notes,
      }
    })
}

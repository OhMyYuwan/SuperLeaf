export const FRONTEND_PERMISSION_EVIDENCE_ROWS = [
  {
    entrypoint: 'browser-bridge',
    policyId: 'endpoint-normalize',
    surface: 'local-agent-endpoint',
    resource: 'local_agent_endpoint',
    action: 'normalize',
    subjectBinding: 'browser-configured-endpoint',
    ownerBoundary: 'localhost-or-loopback-only',
    runtimeGuards: [
      'http-or-https-only',
      'localhost-or-loopback-host',
      'strip-query-and-hash',
    ],
    behaviorEvidence: [
      {
        testModule: 'src/services/browserToolBridge.security.test.ts',
        evidence: 'normalizes only localhost and loopback Local Agent endpoints',
      },
      {
        testModule: 'src/services/browserToolBridge.security.test.ts',
        evidence: 'does not post browser bridge context to untrusted endpoints',
      },
    ],
  },
  {
    entrypoint: 'browser-bridge',
    policyId: 'context-register',
    surface: 'POST /superleaf/mcp/context',
    resource: 'browser_bridge_context',
    action: 'register_or_refresh',
    subjectBinding: 'browser-local-token+active-resource-context',
    ownerBoundary: 'active-project-conversation-document',
    runtimeGuards: [
      'loopback-endpoint-only',
      'local-agent-token-header',
      'context-secret-refresh',
    ],
    behaviorEvidence: [
      {
        testModule: 'src/services/browserToolBridge.security.test.ts',
        evidence: 'attaches browser-local Local Agent Host auth token to loopback context registration',
      },
    ],
  },
  {
    entrypoint: 'browser-bridge',
    policyId: 'tool-poll',
    surface: 'GET /superleaf/mcp/tool-requests',
    resource: 'browser_bridge_tool_request',
    action: 'poll',
    subjectBinding: 'browser-local-token+context-secret',
    ownerBoundary: 'active-browser-bridge-context',
    runtimeGuards: [
      'loopback-endpoint-only',
      'local-agent-token-header',
      'context-id-query',
      'context-secret-header',
      'active-resource-binding-validation',
    ],
    behaviorEvidence: [
      {
        testModule: 'src/services/browserToolBridge.security.test.ts',
        evidence: 'allows tool requests bound to the active browser bridge context',
      },
      {
        testModule: 'src/services/browserToolBridge.security.test.ts',
        evidence: 'rejects tool requests that try to spend the browser session on another resource',
      },
    ],
  },
  {
    entrypoint: 'browser-bridge',
    policyId: 'tool-result',
    surface: 'POST /superleaf/mcp/tool-results',
    resource: 'browser_bridge_tool_result',
    action: 'submit',
    subjectBinding: 'browser-local-token+context-secret+request-lease',
    ownerBoundary: 'active-browser-bridge-request',
    runtimeGuards: [
      'loopback-endpoint-only',
      'local-agent-token-header',
      'context-secret-submit',
      'lease-secret-submit',
      'active-resource-binding-validation',
    ],
    behaviorEvidence: [
      {
        testModule: 'src/services/browserToolBridge.security.test.ts',
        evidence: 'rejects tool requests that try to spend the browser session on another resource',
      },
    ],
  },
  {
    entrypoint: 'browser-bridge',
    policyId: 'approval-poll',
    surface: 'GET /superleaf/mcp/approval-requests',
    resource: 'browser_bridge_approval_request',
    action: 'poll',
    subjectBinding: 'browser-local-token+context-secret',
    ownerBoundary: 'active-browser-bridge-context',
    runtimeGuards: [
      'loopback-endpoint-only',
      'local-agent-token-header',
      'context-id-query',
      'context-secret-header',
      'active-resource-binding-validation',
      'mismatched-approval-auto-reject',
    ],
    behaviorEvidence: [
      {
        testModule: 'src/services/browserToolBridge.security.test.ts',
        evidence: 'rejects approval requests that target another active resource binding',
      },
      {
        testModule: 'src/services/browserToolBridge.security.test.ts',
        evidence: 'rejects mismatched approval requests before surfacing them to the UI',
      },
    ],
  },
  {
    entrypoint: 'browser-bridge',
    policyId: 'approval-result',
    surface: 'POST /superleaf/mcp/approval-results',
    resource: 'browser_bridge_approval_result',
    action: 'submit',
    subjectBinding: 'browser-local-token+context-secret+approval-secret',
    ownerBoundary: 'active-browser-bridge-approval',
    runtimeGuards: [
      'loopback-endpoint-only',
      'local-agent-token-header',
      'context-secret-submit',
      'approval-secret-submit',
      'active-resource-binding-validation',
    ],
    behaviorEvidence: [
      {
        testModule: 'src/services/browserToolBridge.security.test.ts',
        evidence: 'rejects mismatched approval requests before surfacing them to the UI',
      },
    ],
  },
  {
    entrypoint: 'project-event',
    policyId: 'annotation-private-event',
    surface: 'ProjectEventBridge annotation events',
    resource: 'annotation_event',
    action: 'apply_remote_update',
    subjectBinding: 'current-user-id+backend-filtered-project-event',
    ownerBoundary: 'current-user-private-annotations-or-global-events',
    runtimeGuards: [
      'drop-other-user-private-annotation-events',
      'remove-local-annotation-when-unpublished-to-current-user',
      'project-event-seq-gap-reload',
    ],
    behaviorEvidence: [
      {
        testModule: 'src/features/shared/ProjectEventBridge.test.ts',
        evidence: 'does not add private annotation events that belong to another user',
      },
      {
        testModule: 'src/features/shared/ProjectEventBridge.test.ts',
        evidence: 'removes a local annotation when an update makes it private to another user',
      },
    ],
  },
]

export function buildFrontendPermissionEvidenceMatrix() {
  return FRONTEND_PERMISSION_EVIDENCE_ROWS.map((row) => ({
    ...row,
    runtimeGuards: [...row.runtimeGuards],
    behaviorEvidence: row.behaviorEvidence.map((evidence) => ({ ...evidence })),
  }))
}

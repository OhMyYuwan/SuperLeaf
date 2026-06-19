import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as permissionGate from './permission-matrix-gate.mjs'
import {
  PERMISSION_MATRIX_GATES,
  formatGateList,
  validatePermissionMatrixGateManifest,
} from './permission-matrix-gate.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const REQUIRED_GATE_IDS = [
  'permission-matrix-manifest',
  'backend-permission-registry',
  'backend-api-idor-behavior',
  'backend-security-hardening-behavior',
  'backend-mcp-agent-behavior',
  'backend-data-integrity-behavior',
  'collab-server-policy',
  'local-agent-host-policy',
  'local-agent-host-mcp-sdk',
  'local-agent-host-mcp-smoke',
  'frontend-browser-bridge-security',
  'frontend-unit-behavior',
]

const REQUIRED_BACKEND_HARDENING_TESTS = [
  'test/test_collab_gateway.py',
  'test/test_git_timeout.py',
  'test/test_mcp_redos_mitigation.py',
  'test/test_mcp_last_used_throttle.py',
  'test/test_mcp_stdio_policy.py',
  'test/test_multimodal_attachments.py',
  'test/test_native_agent_decode_errors.py',
  'test/test_project_entry_name_validation.py',
  'test/test_safe_http.py',
  'test/test_skill_npx_install_policy.py',
]

test('permission matrix gate manifest includes every high-risk entrance family', () => {
  const ids = PERMISSION_MATRIX_GATES.map((gate) => gate.id)
  for (const id of REQUIRED_GATE_IDS) {
    assert.ok(ids.includes(id), `${id} missing from permission matrix gate manifest`)
  }
})

test('permission matrix gate manifest is self-consistent', () => {
  assert.deepEqual(validatePermissionMatrixGateManifest(PERMISSION_MATRIX_GATES), [])
  for (const gate of PERMISSION_MATRIX_GATES) {
    assert.equal(typeof gate.id, 'string')
    assert.ok(gate.id.length > 0)
    assert.equal(typeof gate.cwd, 'string')
    assert.ok(gate.cwd.length > 0)
    assert.ok(Array.isArray(gate.command))
    assert.ok(gate.command.length > 0)
    assert.ok(gate.command.every((part) => typeof part === 'string' && part.length > 0))
  }
})

test('permission matrix gate commands name the concrete coverage suites', () => {
  const byId = new Map(PERMISSION_MATRIX_GATES.map((gate) => [gate.id, gate.command.join(' ')]))

  assert.match(byId.get('permission-matrix-manifest') ?? '', /node --test scripts\/permission-matrix-gate\.test\.mjs/u)
  assert.match(byId.get('backend-permission-registry') ?? '', /test_permission_policy_registry\.py/u)
  assert.match(byId.get('backend-api-idor-behavior') ?? '', /test_project_idor_permissions\.py/u)
  assert.match(byId.get('backend-api-idor-behavior') ?? '', /test_filesystem_idor_permissions\.py/u)
  assert.match(byId.get('backend-api-idor-behavior') ?? '', /test_dataset_idor_permissions\.py/u)
  assert.match(byId.get('backend-api-idor-behavior') ?? '', /test_native_agent_private_idor_permissions\.py/u)
  assert.match(byId.get('backend-api-idor-behavior') ?? '', /test_admin_api_permissions\.py/u)
  assert.match(byId.get('backend-security-hardening-behavior') ?? '', /test_document_binding_security\.py/u)
  assert.match(byId.get('backend-security-hardening-behavior') ?? '', /test_native_agent_prompt_injection_security\.py/u)
  assert.match(byId.get('backend-security-hardening-behavior') ?? '', /test_project_event_privacy\.py/u)
  assert.match(byId.get('backend-security-hardening-behavior') ?? '', /test_workflow_scope_security\.py/u)
  for (const testModule of REQUIRED_BACKEND_HARDENING_TESTS) {
    assert.ok(
      byId.get('backend-security-hardening-behavior')?.includes(testModule),
      `${testModule} missing from backend-security-hardening-behavior`,
    )
  }
  assert.match(byId.get('backend-mcp-agent-behavior') ?? '', /test_backend_mcp_mount_policy\.py/u)
  assert.match(byId.get('backend-mcp-agent-behavior') ?? '', /test_backend_mcp_rpc\.py/u)
  assert.match(byId.get('backend-mcp-agent-behavior') ?? '', /test_superleaf_mcp_registry\.py/u)
  assert.match(byId.get('backend-mcp-agent-behavior') ?? '', /test_superleaf_mcp_write_tools\.py/u)
  assert.match(byId.get('backend-data-integrity-behavior') ?? '', /test_compile_collab_flush\.py/u)
  assert.match(byId.get('backend-data-integrity-behavior') ?? '', /test_dataset_project\.py/u)
  assert.match(byId.get('backend-data-integrity-behavior') ?? '', /test_doc_format_detection\.py/u)
  assert.match(byId.get('backend-data-integrity-behavior') ?? '', /test_versions_api\.py/u)
  assert.match(byId.get('collab-server-policy') ?? '', /npm test/u)
  assert.match(byId.get('local-agent-host-policy') ?? '', /test:auth/u)
  assert.match(byId.get('local-agent-host-mcp-sdk') ?? '', /gate:mcp-sdk/u)
  assert.match(byId.get('local-agent-host-mcp-smoke') ?? '', /smoke:mcp/u)
  assert.match(byId.get('frontend-browser-bridge-security') ?? '', /browserToolBridge\.security\.test\.ts/u)
  assert.match(byId.get('frontend-browser-bridge-security') ?? '', /permission-policy\.test\.ts/u)
  assert.match(byId.get('frontend-browser-bridge-security') ?? '', /ProjectEventBridge\.test\.ts/u)
  assert.doesNotMatch(byId.get('frontend-browser-bridge-security') ?? '', /src\/__tests__/u)
})

test('backend API/IDOR gate includes every cross-user registry behavior module', () => {
  const backendApiGate = PERMISSION_MATRIX_GATES.find((gate) => gate.id === 'backend-api-idor-behavior')
  assert.ok(backendApiGate, 'backend-api-idor-behavior missing from manifest')
  assert.equal(typeof permissionGate.findMissingGateCommandModules, 'function')

  const registryModules = readBackendCrossUserTestModules()
  assert.ok(registryModules.length > 0, 'backend cross-user registry exported no test modules')
  assert.deepEqual(permissionGate.findMissingGateCommandModules(backendApiGate, registryModules), [])
})

test('backend registry checks default stale cross-user coverage entries', () => {
  const registrySource = readFileSync(
    path.join(repoRoot, 'services/backend/test/test_permission_policy_registry.py'),
    'utf8',
  )

  assert.match(
    registrySource,
    /def test_cross_user_test_coverage_entries_still_match_api_policies\(\) -> None:[\s\S]*find_stale_cross_user_test_policies\(\)[\s\S]*assert stale == \[\]/u,
  )
})

test('backend MCP/Agent gate includes every registry behavior module', () => {
  const backendMcpAgentGate = PERMISSION_MATRIX_GATES.find((gate) => gate.id === 'backend-mcp-agent-behavior')
  assert.ok(backendMcpAgentGate, 'backend-mcp-agent-behavior missing from manifest')
  assert.equal(typeof permissionGate.findMissingGateCommandModules, 'function')
  assert.equal(typeof permissionGate.readBackendRegistryTestModules, 'function')

  const registryModules = permissionGate.readBackendRegistryTestModules([
    'MCP_TRANSPORT_TEST_POLICIES',
    'AGENT_COMMAND_TEST_POLICIES',
  ])
  assert.ok(registryModules.length > 0, 'backend MCP/Agent registry exported no test modules')
  assert.deepEqual(permissionGate.findMissingGateCommandModules(backendMcpAgentGate, registryModules), [])
})

test('backend MCP/Agent gate includes every backend-native MCP test module', () => {
  const backendMcpAgentGate = PERMISSION_MATRIX_GATES.find((gate) => gate.id === 'backend-mcp-agent-behavior')
  assert.ok(backendMcpAgentGate, 'backend-mcp-agent-behavior missing from manifest')

  const backendMcpModules = readBackendNativeMcpTestModules()
  assert.ok(backendMcpModules.length > 0, 'backend-native MCP test discovery found no modules')
  assert.deepEqual(permissionGate.findMissingGateCommandModules(backendMcpAgentGate, backendMcpModules), [])
})

test('backend MCP/Agent gate includes every direct Agent Command test module', () => {
  const backendMcpAgentGate = PERMISSION_MATRIX_GATES.find((gate) => gate.id === 'backend-mcp-agent-behavior')
  assert.ok(backendMcpAgentGate, 'backend-mcp-agent-behavior missing from manifest')

  const agentCommandModules = readBackendAgentCommandTestModules()
  assert.ok(agentCommandModules.length > 0, 'direct Agent Command test discovery found no modules')
  assert.deepEqual(permissionGate.findMissingGateCommandModules(backendMcpAgentGate, agentCommandModules), [])
})

test('backend permission gates include every security-like backend test module', () => {
  const registryModules = readBackendSecurityLikeTestModules()
  assert.ok(registryModules.length > 0, 'backend security-like test discovery found no modules')
  for (const testModule of REQUIRED_BACKEND_HARDENING_TESTS) {
    assert.ok(registryModules.includes(testModule), `${testModule} missing from security-like discovery`)
  }

  const commandModules = new Set(
    PERMISSION_MATRIX_GATES
      .filter((gate) => gate.cwd === 'services/backend')
      .flatMap((gate) => gate.command),
  )
  const missing = registryModules.filter((testModule) => !commandModules.has(testModule))

  assert.deepEqual(missing, [])
})

test('backend permission gates explicitly assign every backend test module once', () => {
  const backendModules = readAllBackendTestModules()
  assert.ok(backendModules.length > 0, 'backend test discovery found no modules')

  const assignments = readBackendGateTestModuleAssignments()
  const missing = backendModules.filter((testModule) => !assignments.has(testModule))
  const duplicates = [...assignments.entries()]
    .filter(([, count]) => count > 1)
    .map(([testModule]) => testModule)
    .sort()

  assert.deepEqual(missing, [])
  assert.deepEqual(duplicates, [])
})

test('frontend permission gate includes every frontend security/privacy test module', () => {
  const frontendGate = PERMISSION_MATRIX_GATES.find((gate) => gate.id === 'frontend-browser-bridge-security')
  assert.ok(frontendGate, 'frontend-browser-bridge-security missing from manifest')

  const frontendModules = readFrontendSecurityLikeTestModules()
  assert.ok(frontendModules.length > 0, 'frontend security/privacy test discovery found no modules')
  assert.deepEqual(permissionGate.findMissingGateCommandModules(frontendGate, frontendModules), [])
})

test('frontend unit behavior gate runs the full Vitest discovery suite', () => {
  const frontendUnitGate = PERMISSION_MATRIX_GATES.find((gate) => gate.id === 'frontend-unit-behavior')
  assert.ok(frontendUnitGate, 'frontend-unit-behavior missing from manifest')

  assert.equal(frontendUnitGate.cwd, 'services/frontend')
  assert.deepEqual(frontendUnitGate.command, ['npx', 'vitest', 'run'])
})

test('root manifest can read non-backend materialized permission evidence matrices', () => {
  assert.equal(typeof permissionGate.readCollabServerPermissionEvidenceMatrix, 'function')
  assert.equal(typeof permissionGate.readLocalAgentHostPermissionEvidenceMatrix, 'function')
  assert.equal(typeof permissionGate.readFrontendPermissionEvidenceMatrix, 'function')

  const collabRows = permissionGate.readCollabServerPermissionEvidenceMatrix()
  assert.ok(collabRows.length > 0, 'collab-server evidence matrix is empty')
  const collabDocRead = collabRows.find((row) => row.entrypoint === 'http' && row.routeId === 'doc_text_read')
  assert.equal(collabDocRead?.subjectBinding, 'backend-internal-token')
  assert.equal(collabDocRead?.ownerBoundary, 'backend-authorized-doc')
  assert.ok(collabDocRead?.runtimeGuards.includes('collab-internal-token'))
  const collabWsSync = collabRows.find((row) => row.entrypoint === 'websocket' && row.routeId === 'document_yjs_sync')
  assert.equal(collabWsSync?.subjectBinding, 'backend-verified-user-doc')
  assert.equal(collabWsSync?.ownerBoundary, 'backend-doc-membership')
  assert.ok(collabWsSync?.runtimeGuards.includes('message-time-reauth'))

  const localRows = permissionGate.readLocalAgentHostPermissionEvidenceMatrix()
  assert.ok(localRows.length > 0, 'Local Agent Host evidence matrix is empty')
  const toolResults = localRows.find((row) => row.policy_id === 'mcp-tool-results')
  assert.equal(toolResults?.subject_binding, 'local-token+browser-context-secret+request-lease')
  assert.equal(toolResults?.owner_boundary, 'browser-bridge-tool-request')
  assert.ok(toolResults?.runtime_guards.includes('request-lease-secret'))
  const codexTurn = localRows.find((row) => row.policy_id === 'codex-turn-create')
  assert.equal(codexTurn?.subject_binding, 'local-user-token')
  assert.equal(codexTurn?.owner_boundary, 'user-local-workspace')
  assert.ok(codexTurn?.runtime_guards.includes('workspace-path-validation'))

  const frontendRows = permissionGate.readFrontendPermissionEvidenceMatrix()
  assert.ok(frontendRows.length > 0, 'frontend evidence matrix is empty')
  const bridgeToolResult = frontendRows.find((row) => row.entrypoint === 'browser-bridge' && row.policyId === 'tool-result')
  assert.equal(bridgeToolResult?.subjectBinding, 'browser-local-token+context-secret+request-lease')
  assert.equal(bridgeToolResult?.ownerBoundary, 'active-browser-bridge-request')
  assert.ok(bridgeToolResult?.runtimeGuards.includes('lease-secret-submit'))
  const annotationPrivacy = frontendRows.find((row) => row.entrypoint === 'project-event' && row.policyId === 'annotation-private-event')
  assert.equal(annotationPrivacy?.ownerBoundary, 'current-user-private-annotations-or-global-events')
  assert.ok(annotationPrivacy?.runtimeGuards.includes('drop-other-user-private-annotation-events'))
})

test('root manifest can read backend materialized permission evidence matrices', () => {
  assert.equal(typeof permissionGate.readBackendPermissionEvidenceMatrices, 'function')

  const backendMatrices = permissionGate.readBackendPermissionEvidenceMatrices()
  assert.equal(backendMatrices.apiRoutes.length, 222)
  assert.equal(backendMatrices.mcpTransports.length, 4)
  assert.equal(backendMatrices.agentCommands.length, 10)

  const docsRead = backendMatrices.apiRoutes.find((row) => row.method === 'GET' && row.path === '/api/docs/{doc_id}')
  assert.equal(docsRead?.resource, 'doc')
  assert.equal(docsRead?.expected_foreign_status, 404)
  assert.ok(docsRead?.test_module.includes('test_filesystem_idor_permissions.py'))

  const mcpPost = backendMatrices.mcpTransports.find((row) => row.method === 'POST' && row.path === '/mcp')
  assert.equal(mcpPost?.auth_surface, 'mcp-token')
  assert.ok(mcpPost?.test_module.includes('test_backend_mcp_rpc.py'))

  const writeTool = backendMatrices.agentCommands.find((row) => row.name === 'project_write_text_file')
  assert.equal(writeTool?.resource, 'doc')
  assert.equal(writeTool?.auth_surface, 'mcp-agent-command')
  assert.ok(writeTool?.test_module.includes('test_superleaf_mcp_write_tools.py'))
})

test('root manifest can read backend sparse resource and API policy summary', () => {
  assert.equal(typeof permissionGate.readBackendPermissionPolicySummary, 'function')

  const summary = permissionGate.readBackendPermissionPolicySummary()
  assert.deepEqual(summary.counts, {
    actionPolicies: 75,
    agentCommandPolicies: 10,
    apiPolicies: 218,
    crossUserTestPolicies: 222,
    mcpTransportPolicies: 4,
    resourcePolicies: 47,
  })

  assert.equal(summary.resources.project.boundary, 'project_membership')
  assert.equal(summary.resources.doc.parent_resource, 'project')
  assert.equal(summary.resources.provider.boundary, 'user_private')
  assert.equal(summary.actions.project_admin.required, 'project_owner')
  assert.equal(summary.actions.doc_read.required, 'project_read')
  assert.equal(summary.actions.provider_manage.required, 'user_private')
  assert.equal(summary.api.project_patch.resource, 'project')
  assert.equal(summary.api.project_patch.action, 'admin')
  assert.equal(summary.api.doc_read.helper, 'get_current_project')
  assert.equal(summary.api.provider_create.auth_surface, 'session')
})

test('root manifest can read non-backend permission policy row counts', () => {
  assert.equal(typeof permissionGate.readNonBackendPermissionPolicySummary, 'function')

  const summary = permissionGate.readNonBackendPermissionPolicySummary()
  assert.deepEqual(summary, {
    collabHttpPolicies: 5,
    collabWsPolicies: 1,
    frontendPolicies: 7,
    localAgentHostHttpPolicies: 27,
  })
})

test('Local Agent Host source stays external-sensitive under parent repository ignores', () => {
  const externalSourceFiles = [
    'services/local-agent-host/package.json',
    'services/local-agent-host/server.mjs',
    'services/local-agent-host/permission-policy.mjs',
    'services/local-agent-host/server-auth.test.mjs',
    'services/local-agent-host/backend-mcp-client.mjs',
    'services/local-agent-host/superleaf-tools.mjs',
    'services/local-agent-host/scripts/smoke-mcp.mjs',
  ]
  const ignoredRuntimeFiles = [
    'services/local-agent-host/.env',
    'services/local-agent-host/local-agent-host.log',
    'services/local-agent-host/local-agent-host.pid',
    'services/local-agent-host/node_modules/example/index.js',
    'services/local-agent-host/dist/server.js',
    'services/local-agent-host/.git/config',
  ]

  assert.equal(isGitIgnored('services/local-agent-host.repository.json'), false)
  for (const filePath of externalSourceFiles) {
    assert.equal(isGitIgnored(filePath), true, `${filePath} must stay external to the parent repository`)
  }
  for (const filePath of ignoredRuntimeFiles) {
    assert.equal(isGitIgnored(filePath), true, `${filePath} must stay ignored`)
  }
})

test('root manifest reads Local Agent Host external-sensitive repository workflow', () => {
  assert.equal(typeof permissionGate.readLocalAgentHostRepositoryWorkflow, 'function')

  const workflow = permissionGate.readLocalAgentHostRepositoryWorkflow()
  assert.equal(workflow.path, 'services/local-agent-host')
  assert.equal(workflow.selectedWorkflow, 'explicit-submodule-or-independent-repo')
  assert.equal(workflow.sensitivity, 'external-sensitive')
  assert.equal(workflow.parentTracking, 'ignored')
  assert.equal(workflow.permissionMatrixValidation, 'validate-local-checkout')
  assert.equal(workflow.userDecisionRecorded, true)
  assert.ok(workflow.requiredParentIgnores.includes('services/local-agent-host/'))
})

test('root manifest exposes Local Agent Host embedded repository topology', () => {
  assert.equal(typeof permissionGate.readLocalAgentHostRepositoryTopology, 'function')

  const topology = permissionGate.readLocalAgentHostRepositoryTopology()
  assert.equal(topology.path, 'services/local-agent-host')
  assert.equal(topology.kind, 'embedded-git')
  assert.equal(topology.branch, 'main')
  assert.match(topology.head, /^[0-9a-f]{7,40}$/u)
  assert.deepEqual(topology.remotes, [])
  assert.ok(Array.isArray(topology.dirtyFiles))
  assert.ok(topology.dirtyFiles.every((filePath) => typeof filePath === 'string' && filePath.length > 0))
})

test('root manifest exposes permission matrix closure blockers', () => {
  assert.equal(typeof permissionGate.readPermissionMatrixClosureStatus, 'function')

  const status = permissionGate.readPermissionMatrixClosureStatus()
  assert.equal(status.gates, PERMISSION_MATRIX_GATES.length)
  assert.deepEqual(status.policyRows, {
    backendActions: 75,
    backendAgentCommandPolicies: 10,
    backendApiPolicies: 218,
    backendCrossUserTestPolicies: 222,
    backendMcpTransportPolicies: 4,
    backendResources: 47,
    collabHttpPolicies: 5,
    collabWsPolicies: 1,
    frontendPolicies: 7,
    localAgentHostHttpPolicies: 27,
  })
  assert.deepEqual(status.evidenceRows, {
    backendAgentCommand: 10,
    backendApi: 222,
    backendMcpTransport: 4,
    collabServer: 6,
    frontend: 7,
    localAgentHost: 27,
  })
  assert.equal(status.complete, true)
  assert.deepEqual(status.blockers, [])
  assert.equal(status.localAgentHostRepositoryWorkflow.selectedWorkflow, 'explicit-submodule-or-independent-repo')
  assert.equal(status.localAgentHostRepositoryWorkflow.sensitivity, 'external-sensitive')
  assert.equal(status.localAgentHostTopology.kind, 'embedded-git')
  assert.ok(Array.isArray(status.localAgentHostTopology.dirtyFiles))
})

test('root manifest exposes Local Agent Host parent repository tracking preflight', () => {
  assert.equal(typeof permissionGate.readLocalAgentHostParentTrackingPreflight, 'function')

  const preflight = permissionGate.readLocalAgentHostParentTrackingPreflight()
  assert.equal(preflight.path, 'services/local-agent-host')
  assert.ok(preflight.sourceFiles.includes('services/local-agent-host/package.json'))
  assert.ok(preflight.sourceFiles.includes('services/local-agent-host/permission-policy.mjs'))
  assert.ok(preflight.sourceFiles.includes('services/local-agent-host/.env.example'))
  assert.ok(!preflight.sourceFiles.includes('services/local-agent-host/.env'))
  assert.ok(preflight.ignoredSourceFiles.includes('services/local-agent-host/permission-policy.mjs'))
  assert.ok(preflight.untrackedSourceFiles.includes('services/local-agent-host/permission-policy.mjs'))
  assert.ok(preflight.untrackedSourceFiles.includes('services/local-agent-host/package.json'))
  assert.equal(preflight.embeddedGitMetadataIgnored, true)
  assert.equal(preflight.canAdoptParentTrackingWithoutRuntimeLeak, false)

  const runtimeByPath = new Map(preflight.runtimeArtifacts.map((artifact) => [artifact.path, artifact]))
  for (const runtimePath of [
    'services/local-agent-host/.env',
    'services/local-agent-host/local-agent-host.log',
    'services/local-agent-host/local-agent-host.pid',
    'services/local-agent-host/node_modules/example/index.js',
    'services/local-agent-host/dist/server.js',
    'services/local-agent-host/.git/config',
  ]) {
    assert.equal(runtimeByPath.get(runtimePath)?.ignored, true, `${runtimePath} must remain ignored`)
  }
})

test('permission matrix closure status includes Local Agent Host parent tracking preflight', () => {
  const status = permissionGate.readPermissionMatrixClosureStatus()

  assert.equal(status.localAgentHostParentTrackingPreflight.path, 'services/local-agent-host')
  assert.ok(
    status.localAgentHostParentTrackingPreflight.ignoredSourceFiles.includes(
      'services/local-agent-host/permission-policy.mjs',
    ),
  )
  assert.equal(status.localAgentHostParentTrackingPreflight.embeddedGitMetadataIgnored, true)
})

test('root manifest exposes Local Agent Host parent adoption plan', () => {
  assert.equal(typeof permissionGate.readLocalAgentHostParentAdoptionPlan, 'function')

  const plan = permissionGate.readLocalAgentHostParentAdoptionPlan()
  assert.equal(plan.path, 'services/local-agent-host')
  assert.equal(plan.recommendedTopology, 'explicit-submodule-or-independent-repo')
  assert.equal(plan.readyToExecute, false)
  assert.equal(plan.requiresUserDecision, false)
  assert.deepEqual(plan.sourceFilesToAdd, [])
  assert.ok(plan.sourceFilesToKeepExternal.includes('services/local-agent-host/package.json'))
  assert.ok(plan.sourceFilesToKeepExternal.includes('services/local-agent-host/permission-policy.mjs'))
  assert.ok(plan.runtimeArtifactsToKeepIgnored.includes('services/local-agent-host/.env'))
  assert.ok(plan.runtimeArtifactsToKeepIgnored.includes('services/local-agent-host/.git/config'))

  const workflowAction = plan.requiredActions.find((action) => action.id === 'use-independent-repository-workflow')
  assert.ok(workflowAction)
  assert.equal(workflowAction.status, 'complete')
  assert.match(workflowAction.reason, /external-sensitive/u)

  const parentIgnoreAction = plan.requiredActions.find((action) => action.id === 'keep-local-agent-host-ignored-by-parent')
  assert.ok(parentIgnoreAction)
  assert.equal(parentIgnoreAction.status, 'complete')
})

test('permission matrix closure status includes Local Agent Host parent adoption plan', () => {
  const status = permissionGate.readPermissionMatrixClosureStatus()

  assert.equal(status.localAgentHostParentAdoptionPlan.path, 'services/local-agent-host')
  assert.equal(status.localAgentHostParentAdoptionPlan.recommendedTopology, 'explicit-submodule-or-independent-repo')
  assert.equal(status.localAgentHostParentAdoptionPlan.readyToExecute, false)
})

test('root manifest exposes Local Agent Host adoption decision packet', () => {
  assert.equal(typeof permissionGate.readLocalAgentHostAdoptionDecisionPacket, 'function')

  const packet = permissionGate.readLocalAgentHostAdoptionDecisionPacket()
  assert.equal(packet.path, 'services/local-agent-host')
  assert.equal(packet.recommendedTopology, 'explicit-submodule-or-independent-repo')
  assert.equal(packet.pendingDecision, '')
  assert.equal(packet.closureBlockerId, '')
  assert.equal(packet.nestedGit.kind, 'embedded-git')
  assert.equal(packet.nestedGit.branch, 'main')
  assert.match(packet.nestedGit.head, /^[0-9a-f]{7,40}$/u)
  assert.deepEqual(packet.nestedGit.remotes, [])
  assert.ok(Array.isArray(packet.nestedGit.dirtyFiles))
  assert.equal(packet.parentTracking.canAdoptParentTrackingWithoutRuntimeLeak, false)
  assert.ok(packet.parentTracking.ignoredSourceFiles.includes('services/local-agent-host/permission-policy.mjs'))
  assert.deepEqual(packet.parentTracking.unignoredRuntimeArtifacts, [])
  assert.deepEqual(packet.sourceFilesToAdopt, [])
  assert.ok(packet.sourceFilesToKeepExternal.includes('services/local-agent-host/package.json'))
  assert.ok(packet.sourceFilesToKeepExternal.includes('services/local-agent-host/permission-policy.mjs'))
  assert.ok(packet.runtimeArtifactsToKeepIgnored.includes('services/local-agent-host/.env'))
  assert.ok(packet.runtimeArtifactsToKeepIgnored.includes('services/local-agent-host/.git/config'))
  assert.deepEqual(
    packet.decisionOptions.map((option) => option.id),
    ['parent-repository-source', 'explicit-submodule-or-independent-repo'],
  )
  assert.equal(packet.decisionOptions[0].recommended, false)
  assert.equal(packet.decisionOptions[1].recommended, true)
  assert.ok(packet.nextValidationCommands.includes('node scripts/permission-matrix-gate.mjs --require-closure'))
})

test('permission matrix CLI prints Local Agent Host adoption decision packet as JSON', () => {
  const result = runPermissionGateCli(['--local-agent-host-adoption-packet'])
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')

  const packet = JSON.parse(result.stdout)
  assert.equal(packet.path, 'services/local-agent-host')
  assert.equal(packet.pendingDecision, '')
  assert.equal(packet.nestedGit.kind, 'embedded-git')
  assert.equal(packet.parentTracking.canAdoptParentTrackingWithoutRuntimeLeak, false)
  assert.ok(packet.sourceFilesToKeepExternal.includes('services/local-agent-host/permission-policy.mjs'))
})

test('root manifest exposes objective-level permission matrix completion audit', () => {
  assert.equal(typeof permissionGate.readPermissionMatrixCompletionAudit, 'function')

  const audit = permissionGate.readPermissionMatrixCompletionAudit()
  assert.equal(audit.objective, 'unified-authorization-idor-resource-api-cross-user-matrix')
  assert.equal(audit.complete, true)
  assert.deepEqual(audit.remainingBlockers, [])

  const items = new Map(audit.items.map((item) => [item.id, item]))
  assert.equal(items.get('resource-ownership-matrix')?.status, 'verified')
  assert.equal(items.get('resource-ownership-matrix')?.evidence.backendResources, 47)
  assert.equal(items.get('api-permission-matrix')?.status, 'verified')
  assert.equal(items.get('api-permission-matrix')?.evidence.backendApiPolicies, 218)
  assert.equal(items.get('api-permission-matrix')?.evidence.localAgentHostHttpPolicies, 27)
  assert.equal(items.get('cross-user-test-suite')?.status, 'verified')
  assert.equal(items.get('cross-user-test-suite')?.evidence.backendApiEvidenceRows, 222)
  assert.equal(items.get('all-entry-gate-coverage')?.status, 'verified')
  assert.ok(items.get('all-entry-gate-coverage')?.evidence.gateIds.includes('backend-api-idor-behavior'))
  assert.ok(items.get('all-entry-gate-coverage')?.evidence.gateIds.includes('frontend-browser-bridge-security'))
  assert.equal(items.get('local-agent-host-topology')?.status, 'verified')
  assert.equal(items.get('local-agent-host-topology')?.evidence.recommendedTopology, 'explicit-submodule-or-independent-repo')
  assert.deepEqual(items.get('local-agent-host-topology')?.blockers, [])
})

test('permission matrix CLI prints objective-level completion audit as JSON', () => {
  const result = runPermissionGateCli(['--completion-audit'])
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')

  const audit = JSON.parse(result.stdout)
  assert.equal(audit.complete, true)
  assert.deepEqual(audit.remainingBlockers, [])
  assert.ok(audit.items.some((item) => item.id === 'cross-user-test-suite' && item.status === 'verified'))
  assert.ok(audit.items.some((item) => item.id === 'local-agent-host-topology' && item.status === 'verified'))
})

test('permission matrix CLI prints closure status as JSON', () => {
  const result = runPermissionGateCli(['--closure-status'])
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')

  const status = JSON.parse(result.stdout)
  assert.equal(status.complete, true)
  assert.equal(status.gates, PERMISSION_MATRIX_GATES.length)
  assert.equal(status.evidenceRows.collabServer, 6)
  assert.equal(status.evidenceRows.localAgentHost, 27)
  assert.equal(status.localAgentHostParentTrackingPreflight.canAdoptParentTrackingWithoutRuntimeLeak, false)
  assert.equal(status.localAgentHostParentAdoptionPlan.recommendedTopology, 'explicit-submodule-or-independent-repo')
  assert.deepEqual(status.blockers, [])
})

test('permission matrix CLI can require closure after external-sensitive workflow decision', () => {
  const result = runPermissionGateCli(['--require-closure'])
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('permission matrix gate list output is readable and complete', () => {
  const output = formatGateList(PERMISSION_MATRIX_GATES)
  for (const id of REQUIRED_GATE_IDS) {
    assert.match(output, new RegExp(`\\b${id}\\b`, 'u'))
  }
  assert.match(output, /services\/backend/u)
  assert.match(output, /services\/frontend/u)
  assert.match(output, /services\/collab-server/u)
  assert.match(output, /services\/local-agent-host/u)
})

function readBackendCrossUserTestModules() {
  return permissionGate.readBackendRegistryTestModules(['CROSS_USER_TEST_POLICIES'])
}

function readBackendSecurityLikeTestModules() {
  const testDir = path.join(repoRoot, 'services/backend/test')
  return readdirSync(testDir)
    .filter((name) => name.endsWith('.py'))
    .filter((name) =>
      /(_security|_permissions|_privacy|_scope|_audit|_policy|_mitigation|_idor_|collab_gateway|entry_name_validation|git_timeout|multimodal_attachments|native_agent_decode_errors|safe_http|mcp_token_api|mcp_catalog|mcp_last_used_throttle|collab_token)/u.test(
        name,
      ),
    )
    .map((name) => `test/${name}`)
    .sort()
}

function readAllBackendTestModules() {
  const testDir = path.join(repoRoot, 'services/backend/test')
  return readdirSync(testDir)
    .filter((name) => /^test_.*\.py$/u.test(name))
    .map((name) => `test/${name}`)
    .sort()
}

function readBackendGateTestModuleAssignments() {
  const assignments = new Map()
  for (const testModule of PERMISSION_MATRIX_GATES
    .filter((gate) => gate.cwd === 'services/backend')
    .flatMap((gate) => gate.command)
    .filter((part) => /^test\/.*\.py$/u.test(part))) {
    assignments.set(testModule, (assignments.get(testModule) ?? 0) + 1)
  }
  return assignments
}

function readBackendNativeMcpTestModules() {
  const testDir = path.join(repoRoot, 'services/backend/test')
  return readdirSync(testDir)
    .filter((name) => /^test_(backend_mcp|superleaf_mcp).*\.py$/u.test(name))
    .map((name) => `test/${name}`)
    .sort()
}

function readBackendAgentCommandTestModules() {
  const testDir = path.join(repoRoot, 'services/backend/test')
  return readdirSync(testDir)
    .filter((name) => /^test_agent_command_.*\.py$/u.test(name))
    .map((name) => `test/${name}`)
    .sort()
}

function readFrontendSecurityLikeTestModules() {
  const srcDir = path.join(repoRoot, 'services/frontend/src')
  return readFrontendTestFiles(srcDir)
    .filter((filePath) => {
      const normalized = filePath.split(path.sep).join('/')
      if (/\.security\.test\.ts$/u.test(normalized)) return true
      const content = readFileSync(filePath, 'utf8')
      return /(another user|other user|private annotation|untrusted endpoint|auth token|approval request|active resource)/iu.test(content)
    })
    .map((filePath) => path.relative(path.join(repoRoot, 'services/frontend'), filePath).split(path.sep).join('/'))
    .sort()
}

function readFrontendTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const filePath = path.join(dir, entry.name)
      if (entry.isDirectory()) return readFrontendTestFiles(filePath)
      return entry.isFile() && entry.name.endsWith('.test.ts') ? [filePath] : []
    })
}

function isGitIgnored(filePath) {
  const result = spawnSync('git', ['check-ignore', '-q', filePath], {
    cwd: repoRoot,
    stdio: 'ignore',
  })
  return result.status === 0
}

function runPermissionGateCli(args) {
  const result = spawnSync('node', ['scripts/permission-matrix-gate.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  }
}

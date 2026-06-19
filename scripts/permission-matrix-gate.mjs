#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const PERMISSION_MATRIX_GATES = [
  {
    id: 'permission-matrix-manifest',
    cwd: '.',
    description: 'Root permission matrix manifest and backend cross-user registry drift guard.',
    command: ['node', '--test', 'scripts/permission-matrix-gate.test.mjs'],
  },
  {
    id: 'backend-permission-registry',
    cwd: 'services/backend',
    description: 'Backend sparse resource/API/MCP/Agent Command policy registry and coverage gates.',
    command: ['uv', 'run', 'pytest', 'test/test_permission_policy_registry.py', '-q'],
  },
  {
    id: 'backend-api-idor-behavior',
    cwd: 'services/backend',
    description: 'Backend FastAPI cross-user API behavior tests indexed by the permission registry.',
    command: [
      'uv',
      'run',
      'pytest',
      'test/test_admin_api_permissions.py',
      'test/test_annotation_upsert_security.py',
      'test/test_auth_session_permissions.py',
      'test/test_collab_token_permissions.py',
      'test/test_compile_audit_permissions.py',
      'test/test_compile_history_idor_permissions.py',
      'test/test_conversation_idor_permissions.py',
      'test/test_dataset_idor_permissions.py',
      'test/test_evaluation_scope_security.py',
      'test/test_filesystem_idor_permissions.py',
      'test/test_github_spelling_idor_permissions.py',
      'test/test_mcp_catalog_security.py',
      'test/test_mcp_token_api.py',
      'test/test_native_agent_metadata_permissions.py',
      'test/test_native_agent_private_idor_permissions.py',
      'test/test_notification_idor_permissions.py',
      'test/test_project_idor_permissions.py',
      'test/test_provider_idor_permissions.py',
      'test/test_recent_collaborator_config_permissions.py',
      'test/test_skill_marketplace_security.py',
      'test/test_workflow_idor_permissions.py',
      '-q',
    ],
  },
  {
    id: 'backend-security-hardening-behavior',
    cwd: 'services/backend',
    description: 'Backend security, audit, scope, import/download, and prompt-injection hardening tests.',
    command: [
      'uv',
      'run',
      'pytest',
      'test/test_backend_docs_security.py',
      'test/test_collab_audit_log.py',
      'test/test_collab_gateway.py',
      'test/test_cors_security.py',
      'test/test_document_binding_security.py',
      'test/test_file_download_security.py',
      'test/test_filesystem_audit_permissions.py',
      'test/test_git_timeout.py',
      'test/test_latex_compiler_security.py',
      'test/test_mcp_last_used_throttle.py',
      'test/test_mcp_redos_mitigation.py',
      'test/test_mcp_stdio_policy.py',
      'test/test_multimodal_attachments.py',
      'test/test_native_agent_decode_errors.py',
      'test/test_native_agent_prompt_injection_security.py',
      'test/test_native_agent_tool_kernel_security.py',
      'test/test_project_archive_security.py',
      'test/test_project_entry_name_validation.py',
      'test/test_project_event_privacy.py',
      'test/test_project_import_security.py',
      'test/test_provider_endpoint_security.py',
      'test/test_safe_http.py',
      'test/test_secret_redaction.py',
      'test/test_skill_npx_install_policy.py',
      'test/test_start_sh_security.py',
      'test/test_version_audit_permissions.py',
      'test/test_workflow_scope_security.py',
      '-q',
    ],
  },
  {
    id: 'backend-mcp-agent-behavior',
    cwd: 'services/backend',
    description: 'Backend-native MCP transport and Agent Command behavior evidence.',
    command: [
      'uv',
      'run',
      'pytest',
      'test/test_agent_command_anchors.py',
      'test/test_agent_command_project.py',
      'test/test_agent_command_registry.py',
      'test/test_agent_command_write.py',
      'test/test_backend_mcp_mount_policy.py',
      'test/test_backend_mcp_rpc.py',
      'test/test_superleaf_mcp_registry.py',
      'test/test_superleaf_mcp_tools.py',
      'test/test_superleaf_mcp_write_tools.py',
      'test/test_superleaf_mcp_transport.py',
      'test/test_backend_mcp_protocol.py',
      '-q',
    ],
  },
  {
    id: 'backend-data-integrity-behavior',
    cwd: 'services/backend',
    description: 'Backend data consistency, binary/text classification, and API-adjacent behavior tests.',
    command: [
      'uv',
      'run',
      'pytest',
      'test/test_annotation_training_export.py',
      'test/test_collab_db_only_consistency.py',
      'test/test_compile_collab_flush.py',
      'test/test_dataset_project.py',
      'test/test_doc_format_detection.py',
      'test/test_project_tags.py',
      'test/test_versions_api.py',
      '-q',
    ],
  },
  {
    id: 'collab-server-policy',
    cwd: 'services/collab-server',
    description: 'Collab-server HTTP/WebSocket policy coverage and behavior tests.',
    command: ['npm', 'test'],
  },
  {
    id: 'collab-server-build',
    cwd: 'services/collab-server',
    description: 'Collab-server TypeScript policy/build check.',
    command: ['npm', 'run', 'build'],
  },
  {
    id: 'local-agent-host-policy',
    cwd: 'services/local-agent-host',
    description: 'Local Agent Host route policy coverage and auth behavior tests.',
    command: ['npm', 'run', 'test:auth'],
  },
  {
    id: 'local-agent-host-mcp-sdk',
    cwd: 'services/local-agent-host',
    description: 'Local Agent Host MCP transport/session compatibility gate.',
    command: ['npm', 'run', 'gate:mcp-sdk'],
  },
  {
    id: 'local-agent-host-mcp-smoke',
    cwd: 'services/local-agent-host',
    description: 'Local Agent Host authenticated MCP, resource, prompt, and local session smoke gate.',
    command: ['npm', 'run', 'smoke:mcp'],
  },
  {
    id: 'frontend-browser-bridge-security',
    cwd: 'services/frontend',
    description: 'Frontend browser bridge endpoint/context binding and project-event privacy tests.',
    command: [
      'npx',
      'vitest',
      'run',
      'src/services/browserToolBridge.security.test.ts',
      'src/services/nanobotBrowserClient.security.test.ts',
      'src/services/permission-policy.test.ts',
      'src/features/shared/ProjectEventBridge.test.ts',
      'src/stores/workflowStore.security.test.ts',
    ],
  },
  {
    id: 'frontend-unit-behavior',
    cwd: 'services/frontend',
    description: 'Frontend full Vitest behavior suite for state, collaboration, browser bridge, and dev-server boundaries.',
    command: ['npx', 'vitest', 'run'],
  },
  {
    id: 'frontend-build',
    cwd: 'services/frontend',
    description: 'Frontend TypeScript/build check after browser bridge policy changes.',
    command: ['npm', 'run', 'build'],
  },
]

export function validatePermissionMatrixGateManifest(gates = PERMISSION_MATRIX_GATES) {
  const errors = []
  const ids = new Set()
  for (const gate of gates) {
    if (!gate || typeof gate !== 'object') {
      errors.push('gate must be an object')
      continue
    }
    if (!gate.id) errors.push('gate is missing id')
    if (ids.has(gate.id)) errors.push(`duplicate gate id: ${gate.id}`)
    ids.add(gate.id)
    if (!gate.cwd) errors.push(`${gate.id}: cwd is required`)
    if (!Array.isArray(gate.command) || gate.command.length === 0) {
      errors.push(`${gate.id}: command must be a non-empty array`)
    } else if (gate.command.some((part) => typeof part !== 'string' || part.length === 0)) {
      errors.push(`${gate.id}: command parts must be non-empty strings`)
    }
    if (!gate.description) errors.push(`${gate.id}: description is required`)
  }
  return errors
}

export function findMissingGateCommandModules(gate, expectedModules) {
  if (!gate || !Array.isArray(gate.command)) return [...expectedModules].sort()
  const commandModules = new Set(gate.command)
  return expectedModules
    .filter((testModule) => !commandModules.has(testModule))
    .sort()
}

export function readBackendRegistryTestModules(exportNames) {
  if (!Array.isArray(exportNames) || exportNames.length === 0) {
    throw new Error('exportNames must be a non-empty array')
  }
  if (exportNames.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new Error('exportNames must contain non-empty strings')
  }

  const output = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      [
        'import json, sys',
        'from app.services import permission_policy as policy',
        'modules = set()',
        'for export_name in json.loads(sys.argv[1]):',
        '    for entry in getattr(policy, export_name):',
        '        modules.add(entry.test_module)',
        'print(json.dumps(sorted(modules)))',
      ].join('\n'),
      JSON.stringify(exportNames),
    ],
    {
      cwd: path.join(repoRoot, 'services/backend'),
      encoding: 'utf8',
    },
  )
  return JSON.parse(output)
}

export function readBackendPermissionEvidenceMatrices() {
  const output = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      [
        'import json',
        'from dataclasses import asdict',
        'from app.agent_commands.registry import get_agent_command_tools',
        'from app.api import api_router',
        'from app.mcp.router import router as backend_mcp_router',
        'from app.services import permission_policy as policy',
        'api = policy.build_api_route_cross_user_evidence_matrix(',
        '    api_router.routes,',
        '    include=lambda _method, path: path.startswith("/api/"),',
        ')',
        'mcp = policy.build_mcp_transport_evidence_matrix(backend_mcp_router.routes)',
        'agent = policy.build_agent_command_evidence_matrix({tool["name"] for tool in get_agent_command_tools()})',
        'print(json.dumps({',
        '    "apiRoutes": [asdict(entry) for entry in api],',
        '    "mcpTransports": [asdict(entry) for entry in mcp],',
        '    "agentCommands": [asdict(entry) for entry in agent],',
        '}))',
      ].join('\n'),
    ],
    {
      cwd: path.join(repoRoot, 'services/backend'),
      encoding: 'utf8',
    },
  )
  return JSON.parse(output)
}

export function readBackendPermissionPolicySummary() {
  const output = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      [
        'import json',
        'from dataclasses import asdict',
        'from app.services import permission_policy as policy',
        '',
        'def clean(value):',
        '    if isinstance(value, dict):',
        '        return {key: clean(item) for key, item in value.items()}',
        '    if isinstance(value, (list, tuple)):',
        '        return [clean(item) for item in value]',
        '    return value',
        '',
        'def action(resource, name):',
        '    return clean(asdict(policy.ACTION_POLICIES[(resource, name)]))',
        '',
        'def api(method, path):',
        '    selected = next(item for item in policy.API_POLICIES if item.method == method and item.path == path)',
        '    return clean(asdict(selected))',
        '',
        'summary = {',
        '    "counts": {',
        '        "resourcePolicies": len(policy.RESOURCE_POLICIES),',
        '        "actionPolicies": len(policy.ACTION_POLICIES),',
        '        "apiPolicies": len(policy.API_POLICIES),',
        '        "crossUserTestPolicies": len(policy.CROSS_USER_TEST_POLICIES),',
        '        "mcpTransportPolicies": len(policy.MCP_TRANSPORT_POLICIES),',
        '        "agentCommandPolicies": len(policy.AGENT_COMMAND_POLICIES),',
        '    },',
        '    "resources": {',
        '        "project": clean(asdict(policy.RESOURCE_POLICIES["project"])),',
        '        "doc": clean(asdict(policy.RESOURCE_POLICIES["doc"])),',
        '        "provider": clean(asdict(policy.RESOURCE_POLICIES["provider"])),',
        '        "native_agent_credential": clean(asdict(policy.RESOURCE_POLICIES["native_agent_credential"])),',
        '    },',
        '    "actions": {',
        '        "project_admin": action("project", "admin"),',
        '        "doc_read": action("doc", "read"),',
        '        "provider_manage": action("provider", "manage"),',
        '    },',
        '    "api": {',
        '        "project_patch": api("PATCH", "/api/projects/{project_id}"),',
        '        "doc_read": api("GET", "/api/docs/{doc_id}"),',
        '        "provider_create": api("POST", "/api/providers"),',
        '    },',
        '}',
        'print(json.dumps(summary))',
      ].join('\n'),
    ],
    {
      cwd: path.join(repoRoot, 'services/backend'),
      encoding: 'utf8',
    },
  )
  return JSON.parse(output)
}

export function readCollabServerPermissionEvidenceMatrix() {
  const output = execFileSync(
    'node',
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      [
        "import { buildCollabServerPermissionEvidenceMatrix } from './src/permission-policy.ts'",
        'console.log(JSON.stringify(buildCollabServerPermissionEvidenceMatrix()))',
      ].join('\n'),
    ],
    {
      cwd: path.join(repoRoot, 'services/collab-server'),
      encoding: 'utf8',
    },
  )
  return JSON.parse(output)
}

export function readNonBackendPermissionPolicySummary() {
  const collabOutput = execFileSync(
    'node',
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      [
        "import { COLLAB_HTTP_ROUTE_POLICIES } from './src/persistence.ts'",
        "import { COLLAB_WS_UPGRADE_POLICIES } from './src/upgrade-auth.ts'",
        'console.log(JSON.stringify({',
        '  collabHttpPolicies: COLLAB_HTTP_ROUTE_POLICIES.length,',
        '  collabWsPolicies: COLLAB_WS_UPGRADE_POLICIES.length,',
        '}))',
      ].join('\n'),
    ],
    {
      cwd: path.join(repoRoot, 'services/collab-server'),
      encoding: 'utf8',
    },
  )
  const localAgentOutput = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      [
        "import { LOCAL_AGENT_HTTP_ROUTE_POLICIES } from './permission-policy.mjs'",
        'console.log(JSON.stringify({ localAgentHostHttpPolicies: LOCAL_AGENT_HTTP_ROUTE_POLICIES.length }))',
      ].join('\n'),
    ],
    {
      cwd: path.join(repoRoot, 'services/local-agent-host'),
      encoding: 'utf8',
    },
  )
  const frontendOutput = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      [
        "import { buildFrontendPermissionEvidenceMatrix } from './src/services/permission-policy.mjs'",
        'console.log(JSON.stringify({ frontendPolicies: buildFrontendPermissionEvidenceMatrix().length }))',
      ].join('\n'),
    ],
    {
      cwd: path.join(repoRoot, 'services/frontend'),
      encoding: 'utf8',
    },
  )
  return {
    ...JSON.parse(collabOutput),
    ...JSON.parse(frontendOutput),
    ...JSON.parse(localAgentOutput),
  }
}

export function readLocalAgentHostPermissionEvidenceMatrix() {
  const output = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      [
        "import { buildLocalAgentHttpPermissionEvidenceMatrix } from './permission-policy.mjs'",
        'console.log(JSON.stringify(buildLocalAgentHttpPermissionEvidenceMatrix()))',
      ].join('\n'),
    ],
    {
      cwd: path.join(repoRoot, 'services/local-agent-host'),
      encoding: 'utf8',
    },
  )
  return JSON.parse(output)
}

export function readFrontendPermissionEvidenceMatrix() {
  const output = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      [
        "import { buildFrontendPermissionEvidenceMatrix } from './src/services/permission-policy.mjs'",
        'console.log(JSON.stringify(buildFrontendPermissionEvidenceMatrix()))',
      ].join('\n'),
    ],
    {
      cwd: path.join(repoRoot, 'services/frontend'),
      encoding: 'utf8',
    },
  )
  return JSON.parse(output)
}

export function readLocalAgentHostRepositoryTopology() {
  const relativePath = 'services/local-agent-host'
  const hostRoot = path.join(repoRoot, relativePath)
  const embeddedGit = existsSync(path.join(hostRoot, '.git'))
  if (!embeddedGit) {
    return {
      path: relativePath,
      kind: 'parent-repository-directory',
      branch: '',
      head: '',
      remotes: [],
      dirtyFiles: [],
    }
  }

  return {
    path: relativePath,
    kind: 'embedded-git',
    branch: gitOutput(hostRoot, ['branch', '--show-current']),
    head: gitOutput(hostRoot, ['rev-parse', 'HEAD']),
    remotes: gitOutput(hostRoot, ['remote', '-v'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    dirtyFiles: gitRawOutput(hostRoot, ['status', '--porcelain', '--untracked-files=all'])
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .sort(),
  }
}

export function readLocalAgentHostRepositoryWorkflow() {
  const workflowPath = path.join(repoRoot, 'services/local-agent-host.repository.json')
  if (!existsSync(workflowPath)) {
    return {
      path: 'services/local-agent-host',
      selectedWorkflow: 'parent-repository-source',
      sensitivity: 'normal-source',
      parentTracking: 'tracked',
      permissionMatrixValidation: 'validate-parent-source',
      userDecisionRecorded: false,
      requiredParentIgnores: [],
    }
  }
  return JSON.parse(readFileSync(workflowPath, 'utf8'))
}

export function readPermissionMatrixClosureStatus() {
  const backendPolicySummary = readBackendPermissionPolicySummary()
  const backendEvidence = readBackendPermissionEvidenceMatrices()
  const nonBackendPolicySummary = readNonBackendPermissionPolicySummary()
  const policyRows = {
    backendActions: backendPolicySummary.counts.actionPolicies,
    backendAgentCommandPolicies: backendPolicySummary.counts.agentCommandPolicies,
    backendApiPolicies: backendPolicySummary.counts.apiPolicies,
    backendCrossUserTestPolicies: backendPolicySummary.counts.crossUserTestPolicies,
    backendMcpTransportPolicies: backendPolicySummary.counts.mcpTransportPolicies,
    backendResources: backendPolicySummary.counts.resourcePolicies,
    collabHttpPolicies: nonBackendPolicySummary.collabHttpPolicies,
    collabWsPolicies: nonBackendPolicySummary.collabWsPolicies,
    frontendPolicies: nonBackendPolicySummary.frontendPolicies,
    localAgentHostHttpPolicies: nonBackendPolicySummary.localAgentHostHttpPolicies,
  }
  const evidenceRows = {
    backendAgentCommand: backendEvidence.agentCommands.length,
    backendApi: backendEvidence.apiRoutes.length,
    backendMcpTransport: backendEvidence.mcpTransports.length,
    collabServer: readCollabServerPermissionEvidenceMatrix().length,
    frontend: readFrontendPermissionEvidenceMatrix().length,
    localAgentHost: readLocalAgentHostPermissionEvidenceMatrix().length,
  }
  const localAgentHostTopology = readLocalAgentHostRepositoryTopology()
  const localAgentHostParentTrackingPreflight = readLocalAgentHostParentTrackingPreflight()
  const localAgentHostRepositoryWorkflow = readLocalAgentHostRepositoryWorkflow()
  const localAgentHostParentAdoptionPlan = readLocalAgentHostParentAdoptionPlan()
  const blockers = buildPermissionMatrixClosureBlockers(
    localAgentHostTopology,
    localAgentHostRepositoryWorkflow,
    localAgentHostParentTrackingPreflight,
  )

  return {
    complete: blockers.length === 0,
    gates: PERMISSION_MATRIX_GATES.length,
    policyRows,
    evidenceRows,
    localAgentHostTopology,
    localAgentHostRepositoryWorkflow,
    localAgentHostParentTrackingPreflight,
    localAgentHostParentAdoptionPlan,
    blockers,
  }
}

export function readLocalAgentHostParentTrackingPreflight() {
  const relativePath = 'services/local-agent-host'
  const sourceFiles = discoverLocalAgentHostSourceFiles(relativePath)
  const runtimeArtifacts = [
    'services/local-agent-host/.env',
    'services/local-agent-host/.env.local',
    'services/local-agent-host/local-agent-host.log',
    'services/local-agent-host/local-agent-host.pid',
    'services/local-agent-host/node_modules/example/index.js',
    'services/local-agent-host/dist/server.js',
    'services/local-agent-host/.git/config',
    'services/local-agent-host/superleaf-local-agent-host.manifest.json',
  ].map((artifactPath) => ({
    path: artifactPath,
    ignored: isGitIgnoredByParent(artifactPath),
  }))
  const ignoredSourceFiles = sourceFiles.filter((filePath) => isGitIgnoredByParent(filePath))
  const trackedSourceFiles = sourceFiles.filter((filePath) => isGitTrackedByParent(filePath))
  const untrackedSourceFiles = sourceFiles.filter((filePath) => !trackedSourceFiles.includes(filePath))
  const unignoredRuntimeArtifacts = runtimeArtifacts
    .filter((artifact) => !artifact.ignored)
    .map((artifact) => artifact.path)
  const embeddedGitMetadataIgnored = isGitIgnoredByParent('services/local-agent-host/.git/config')

  return {
    path: relativePath,
    sourceFiles,
    trackedSourceFiles,
    untrackedSourceFiles,
    ignoredSourceFiles,
    runtimeArtifacts,
    unignoredRuntimeArtifacts,
    embeddedGitMetadataIgnored,
    canAdoptParentTrackingWithoutRuntimeLeak:
      ignoredSourceFiles.length === 0 && unignoredRuntimeArtifacts.length === 0 && embeddedGitMetadataIgnored,
  }
}

export function readLocalAgentHostParentAdoptionPlan() {
  const topology = readLocalAgentHostRepositoryTopology()
  const preflight = readLocalAgentHostParentTrackingPreflight()
  const workflow = readLocalAgentHostRepositoryWorkflow()
  const externalWorkflow = isLocalAgentHostExternalSensitiveWorkflow(workflow, preflight)
  if (workflow.selectedWorkflow === 'explicit-submodule-or-independent-repo') {
    const parentIgnoreStatus = externalWorkflow ? 'complete' : 'blocked'
    const requiredActions = [
      {
        id: 'use-independent-repository-workflow',
        status: workflow.userDecisionRecorded ? 'complete' : 'blocked',
        reason: workflow.userDecisionRecorded
          ? 'User decision recorded: Local Agent Host uses an external-sensitive independent/submodule workflow.'
          : 'Record the user decision before treating Local Agent Host as an external-sensitive checkout.',
      },
      {
        id: 'keep-local-agent-host-ignored-by-parent',
        status: parentIgnoreStatus,
        reason:
          parentIgnoreStatus === 'complete'
            ? 'Parent .gitignore excludes Local Agent Host source, runtime files, and nested git metadata.'
            : 'Parent repository must ignore Local Agent Host source and runtime/private artifacts.',
      },
      {
        id: 'validate-local-agent-host-checkout',
        status: existsSync(path.join(repoRoot, workflow.path)) ? 'ready' : 'blocked',
        reason:
          'Run Local Agent Host permission gates against the local external checkout without staging its source in the parent repository.',
        command: 'node scripts/permission-matrix-gate.mjs --only local-agent-host-policy',
      },
      {
        id: 'run-permission-matrix-closure',
        status: externalWorkflow ? 'ready' : 'blocked',
        reason: 'Run node scripts/permission-matrix-gate.mjs --require-closure after confirming the external-sensitive workflow.',
        command: 'node scripts/permission-matrix-gate.mjs --require-closure',
      },
    ]

    return {
      path: preflight.path,
      recommendedTopology: 'explicit-submodule-or-independent-repo',
      readyToExecute: false,
      requiresUserDecision: !workflow.userDecisionRecorded,
      sourceFilesToAdd: [],
      sourceFilesToKeepExternal: preflight.sourceFiles,
      runtimeArtifactsToKeepIgnored: preflight.runtimeArtifacts
        .filter((artifact) => artifact.ignored)
        .map((artifact) => artifact.path),
      requiredActions,
    }
  }

  const embeddedGitPresent = topology.kind === 'embedded-git'
  const safeToAdoptWithoutRuntimeLeak = preflight.canAdoptParentTrackingWithoutRuntimeLeak
  const sourceAddCommand = ['git', 'add', '--', ...preflight.sourceFiles].join(' ')
  const requiredActions = [
    {
      id: 'resolve-embedded-git-metadata',
      status: embeddedGitPresent ? 'requires-user-action' : 'complete',
      reason: embeddedGitPresent
        ? 'services/local-agent-host is currently an embedded git repository; preserve any needed nested history/state, then remove or relocate the nested .git metadata before parent tracking can be finalized.'
        : 'services/local-agent-host is already a parent-repository directory.',
    },
    {
      id: 'verify-runtime-artifact-exclusions',
      status: safeToAdoptWithoutRuntimeLeak ? 'complete' : 'blocked',
      reason: safeToAdoptWithoutRuntimeLeak
        ? 'Parent .gitignore excludes Local Agent Host runtime/private artifacts while leaving source files visible.'
        : 'Parent .gitignore must exclude runtime/private artifacts and leave source files visible before adoption.',
    },
    {
      id: 'add-local-agent-host-source-to-parent',
      status: embeddedGitPresent ? 'blocked-by-embedded-git' : 'ready',
      reason: embeddedGitPresent
        ? 'Parent repository source addition should wait until nested .git metadata is explicitly resolved.'
        : 'Local Agent Host source files can be added to the parent repository.',
      command: sourceAddCommand,
    },
    {
      id: 'run-permission-matrix-closure',
      status: embeddedGitPresent ? 'blocked-by-embedded-git' : 'ready',
      reason: 'Run node scripts/permission-matrix-gate.mjs --require-closure after adopting parent tracking.',
      command: 'node scripts/permission-matrix-gate.mjs --require-closure',
    },
  ]

  return {
    path: preflight.path,
    recommendedTopology: 'parent-repository-source',
    readyToExecute: !embeddedGitPresent && safeToAdoptWithoutRuntimeLeak && preflight.untrackedSourceFiles.length > 0,
    requiresUserDecision: embeddedGitPresent,
    sourceFilesToAdd: preflight.untrackedSourceFiles,
    sourceFilesToKeepExternal: [],
    runtimeArtifactsToKeepIgnored: preflight.runtimeArtifacts
      .filter((artifact) => artifact.ignored)
      .map((artifact) => artifact.path),
    requiredActions,
  }
}

export function readLocalAgentHostAdoptionDecisionPacket() {
  const topology = readLocalAgentHostRepositoryTopology()
  const preflight = readLocalAgentHostParentTrackingPreflight()
  const workflow = readLocalAgentHostRepositoryWorkflow()
  const adoptionPlan = readLocalAgentHostParentAdoptionPlan()
  const blocker = buildPermissionMatrixClosureBlockers(topology, workflow, preflight).find(
    (item) => item.id === 'local-agent-host-embedded-git-dirty',
  )
  const externalWorkflow = workflow.selectedWorkflow === 'explicit-submodule-or-independent-repo'

  return {
    path: adoptionPlan.path,
    recommendedTopology: adoptionPlan.recommendedTopology,
    pendingDecision: externalWorkflow || topology.kind !== 'embedded-git' ? '' : 'resolve-embedded-git-topology',
    closureBlockerId: blocker?.id ?? '',
    nestedGit: topology,
    repositoryWorkflow: workflow,
    parentTracking: {
      canAdoptParentTrackingWithoutRuntimeLeak: preflight.canAdoptParentTrackingWithoutRuntimeLeak,
      ignoredSourceFiles: preflight.ignoredSourceFiles,
      unignoredRuntimeArtifacts: preflight.unignoredRuntimeArtifacts,
      embeddedGitMetadataIgnored: preflight.embeddedGitMetadataIgnored,
    },
    sourceFilesToAdopt: adoptionPlan.sourceFilesToAdd,
    sourceFilesToKeepExternal: adoptionPlan.sourceFilesToKeepExternal,
    runtimeArtifactsToKeepIgnored: adoptionPlan.runtimeArtifactsToKeepIgnored,
    requiredActions: adoptionPlan.requiredActions,
    decisionOptions: [
      {
        id: 'parent-repository-source',
        recommended: !externalWorkflow,
        effect:
          'Preserve any needed nested history, resolve services/local-agent-host/.git, then add Local Agent Host source files to the parent repository so permission policy changes are reviewed with the rest of SuperLeaf.',
      },
      {
        id: 'explicit-submodule-or-independent-repo',
        recommended: externalWorkflow,
        effect:
          'Keep Local Agent Host as a separately governed repository and document the submodule or release workflow before treating the parent permission matrix as closed.',
      },
    ],
    nextValidationCommands: [
      'node scripts/permission-matrix-gate.mjs --only permission-matrix-manifest',
      'node scripts/permission-matrix-gate.mjs --only local-agent-host-policy',
      'node scripts/permission-matrix-gate.mjs --require-closure',
    ],
  }
}

export function readPermissionMatrixCompletionAudit() {
  const status = readPermissionMatrixClosureStatus()
  const gateIds = PERMISSION_MATRIX_GATES.map((gate) => gate.id)
  const remainingBlockers = status.blockers.map((blocker) => blocker.id)

  const items = [
    {
      id: 'resource-ownership-matrix',
      requirement: 'Materialize sparse resource ownership and action policy rows.',
      status: status.policyRows.backendResources > 0 && status.policyRows.backendActions > 0 ? 'verified' : 'missing',
      evidence: {
        backendResources: status.policyRows.backendResources,
        backendActions: status.policyRows.backendActions,
      },
    },
    {
      id: 'api-permission-matrix',
      requirement: 'Materialize API and edge-entry permission policy rows across backend, collab, frontend, and Local Agent Host surfaces.',
      status:
        status.policyRows.backendApiPolicies > 0 &&
        status.policyRows.collabHttpPolicies > 0 &&
        status.policyRows.collabWsPolicies > 0 &&
        status.policyRows.frontendPolicies > 0 &&
        status.policyRows.localAgentHostHttpPolicies > 0
          ? 'verified'
          : 'missing',
      evidence: {
        backendApiPolicies: status.policyRows.backendApiPolicies,
        backendMcpTransportPolicies: status.policyRows.backendMcpTransportPolicies,
        backendAgentCommandPolicies: status.policyRows.backendAgentCommandPolicies,
        collabHttpPolicies: status.policyRows.collabHttpPolicies,
        collabWsPolicies: status.policyRows.collabWsPolicies,
        frontendPolicies: status.policyRows.frontendPolicies,
        localAgentHostHttpPolicies: status.policyRows.localAgentHostHttpPolicies,
      },
    },
    {
      id: 'cross-user-test-suite',
      requirement: 'Index and run cross-user/IDOR behavior evidence for protected resources and API entrypoints.',
      status:
        status.policyRows.backendCrossUserTestPolicies > 0 &&
        status.evidenceRows.backendApi > 0 &&
        status.evidenceRows.backendAgentCommand > 0 &&
        status.evidenceRows.backendMcpTransport > 0 &&
        status.evidenceRows.collabServer > 0 &&
        status.evidenceRows.frontend > 0 &&
        status.evidenceRows.localAgentHost > 0
          ? 'verified'
          : 'missing',
      evidence: {
        backendCrossUserTestPolicies: status.policyRows.backendCrossUserTestPolicies,
        backendApiEvidenceRows: status.evidenceRows.backendApi,
        backendAgentCommandEvidenceRows: status.evidenceRows.backendAgentCommand,
        backendMcpTransportEvidenceRows: status.evidenceRows.backendMcpTransport,
        collabServerEvidenceRows: status.evidenceRows.collabServer,
        frontendEvidenceRows: status.evidenceRows.frontend,
        localAgentHostEvidenceRows: status.evidenceRows.localAgentHost,
      },
    },
    {
      id: 'all-entry-gate-coverage',
      requirement: 'Name concrete gate commands for backend, collab, frontend, and Local Agent Host entrance families.',
      status: validatePermissionMatrixGateManifest(PERMISSION_MATRIX_GATES).length === 0 ? 'verified' : 'missing',
      evidence: {
        gateCount: status.gates,
        gateIds,
      },
    },
    {
      id: 'local-agent-host-topology',
      requirement: 'Resolve Local Agent Host source ownership before treating permission matrix closure as final.',
      status: remainingBlockers.includes('local-agent-host-embedded-git-dirty') ? 'blocked' : 'verified',
      evidence: {
        recommendedTopology: status.localAgentHostParentAdoptionPlan.recommendedTopology,
        pendingDecision: status.localAgentHostParentAdoptionPlan.requiresUserDecision
          ? 'resolve-embedded-git-topology'
          : '',
        repositoryWorkflow: status.localAgentHostRepositoryWorkflow.selectedWorkflow,
        sensitivity: status.localAgentHostRepositoryWorkflow.sensitivity,
        dirtyFiles: status.localAgentHostTopology.dirtyFiles,
      },
      blockers: remainingBlockers.filter((id) => id === 'local-agent-host-embedded-git-dirty'),
    },
  ]

  return {
    objective: 'unified-authorization-idor-resource-api-cross-user-matrix',
    complete: status.complete && items.every((item) => item.status === 'verified'),
    remainingBlockers,
    items,
  }
}

function discoverLocalAgentHostSourceFiles(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) return []

  return readdirSync(absolutePath, { withFileTypes: true })
    .flatMap((entry) => {
      const childRelativePath = `${relativePath}/${entry.name}`
      if (entry.isDirectory()) {
        if (isLocalAgentHostRuntimePath(childRelativePath)) return []
        return discoverLocalAgentHostSourceFiles(childRelativePath)
      }
      if (!entry.isFile() || isLocalAgentHostRuntimePath(childRelativePath)) return []
      return [childRelativePath]
    })
    .sort()
}

function isLocalAgentHostRuntimePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/')
  const fileName = path.basename(normalized)
  return (
    fileName === '.git' ||
    fileName === 'node_modules' ||
    fileName === 'dist' ||
    normalized.includes('/.git/') ||
    normalized.includes('/node_modules/') ||
    normalized.includes('/dist/') ||
    fileName === '.env' ||
    fileName === '.env.local' ||
    (fileName.startsWith('.env.') && !fileName.endsWith('.example')) ||
    fileName.endsWith('.log') ||
    fileName.endsWith('.pid') ||
    fileName === 'superleaf-local-agent-host.manifest.json'
  )
}

function buildPermissionMatrixClosureBlockers(localAgentHostTopology, localAgentHostWorkflow, localAgentHostPreflight) {
  if (
    isLocalAgentHostExternalSensitiveWorkflow(localAgentHostWorkflow, localAgentHostPreflight) &&
    localAgentHostTopology.kind === 'embedded-git'
  ) {
    return []
  }

  if (localAgentHostTopology.kind !== 'embedded-git' || localAgentHostTopology.dirtyFiles.length === 0) {
    return []
  }

  return [
    {
      id: 'local-agent-host-embedded-git-dirty',
      severity: 'requires-decision',
      path: localAgentHostTopology.path,
      message:
        'services/local-agent-host is an embedded git repository with dirty security-policy files; choose parent-repository source tracking or an explicit submodule/independent-repo workflow before treating the permission matrix as closed.',
      dirtyFiles: localAgentHostTopology.dirtyFiles,
    },
  ]
}

function isLocalAgentHostExternalSensitiveWorkflow(workflow, preflight) {
  if (!workflow || !preflight) return false
  return (
    workflow.path === 'services/local-agent-host' &&
    workflow.selectedWorkflow === 'explicit-submodule-or-independent-repo' &&
    workflow.sensitivity === 'external-sensitive' &&
    workflow.parentTracking === 'ignored' &&
    workflow.permissionMatrixValidation === 'validate-local-checkout' &&
    workflow.userDecisionRecorded === true &&
    Array.isArray(workflow.requiredParentIgnores) &&
    workflow.requiredParentIgnores.includes('services/local-agent-host/') &&
    preflight.sourceFiles.length > 0 &&
    preflight.trackedSourceFiles.length === 0 &&
    preflight.ignoredSourceFiles.length === preflight.sourceFiles.length &&
    preflight.unignoredRuntimeArtifacts.length === 0 &&
    preflight.embeddedGitMetadataIgnored === true
  )
}

export function formatGateList(gates = PERMISSION_MATRIX_GATES) {
  return gates
    .map((gate) => {
      return [
        gate.id,
        `  cwd: ${gate.cwd}`,
        `  cmd: ${gate.command.join(' ')}`,
        `  why: ${gate.description}`,
      ].join('\n')
    })
    .join('\n\n')
}

function gitOutput(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function gitRawOutput(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

function isGitIgnoredByParent(filePath) {
  return gitStatusCode(repoRoot, ['check-ignore', '-q', '--', filePath]) === 0
}

function isGitTrackedByParent(filePath) {
  return gitStatusCode(repoRoot, ['ls-files', '--error-unmatch', '--', filePath]) === 0
}

function gitStatusCode(cwd, args) {
  try {
    execFileSync('git', args, {
      cwd,
      stdio: 'ignore',
    })
    return 0
  } catch (err) {
    if (typeof err?.status === 'number') return err.status
    throw err
  }
}

export async function runPermissionMatrixGates(options = {}) {
  const selected = selectGates(options.only ?? [], PERMISSION_MATRIX_GATES)
  const errors = validatePermissionMatrixGateManifest(selected)
  if (errors.length > 0) {
    throw new Error(`Permission matrix gate manifest is invalid:\n${errors.join('\n')}`)
  }

  for (const gate of selected) {
    await runGate(gate)
  }
}

function selectGates(only, gates) {
  if (only.length === 0) return gates
  const selected = []
  const byId = new Map(gates.map((gate) => [gate.id, gate]))
  for (const id of only) {
    const gate = byId.get(id)
    if (!gate) {
      throw new Error(`Unknown permission matrix gate: ${id}\n\n${formatGateList(gates)}`)
    }
    selected.push(gate)
  }
  return selected
}

function runGate(gate) {
  const cwd = path.resolve(repoRoot, gate.cwd)
  console.log(`\n[permission-matrix] ${gate.id}`)
  console.log(`[permission-matrix] cwd: ${gate.cwd}`)
  console.log(`[permission-matrix] cmd: ${gate.command.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(gate.command[0], gate.command.slice(1), {
      cwd,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${gate.id} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`))
    })
  })
}

function parseArgs(argv) {
  const only = []
  let list = false
  let closureStatus = false
  let completionAudit = false
  let localAgentHostAdoptionPacket = false
  let requireClosure = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--list') {
      list = true
    } else if (arg === '--closure-status') {
      closureStatus = true
    } else if (arg === '--completion-audit') {
      completionAudit = true
    } else if (arg === '--local-agent-host-adoption-packet') {
      localAgentHostAdoptionPacket = true
    } else if (arg === '--require-closure') {
      requireClosure = true
    } else if (arg === '--only') {
      const id = argv[i + 1]
      if (!id) throw new Error('--only requires a gate id')
      only.push(id)
      i += 1
    } else if (arg.startsWith('--only=')) {
      only.push(arg.slice('--only='.length))
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { closureStatus, completionAudit, list, localAgentHostAdoptionPacket, only, requireClosure }
}

function formatClosureBlockers(blockers) {
  return blockers
    .map((blocker) => {
      const dirtyFiles = blocker.dirtyFiles?.length ? ` dirty files: ${blocker.dirtyFiles.join(', ')}` : ''
      return `${blocker.id} (${blocker.severity}) at ${blocker.path}: ${blocker.message}${dirtyFiles}`
    })
    .join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.list) {
      console.log(formatGateList(PERMISSION_MATRIX_GATES))
    } else if (args.completionAudit) {
      console.log(JSON.stringify(readPermissionMatrixCompletionAudit(), null, 2))
    } else if (args.localAgentHostAdoptionPacket) {
      console.log(JSON.stringify(readLocalAgentHostAdoptionDecisionPacket(), null, 2))
    } else if (args.closureStatus || args.requireClosure) {
      const status = readPermissionMatrixClosureStatus()
      if (args.closureStatus) {
        console.log(JSON.stringify(status, null, 2))
      }
      if (args.requireClosure && !status.complete) {
        throw new Error(`Permission matrix closure is blocked:\n${formatClosureBlockers(status.blockers)}`)
      }
    } else {
      await runPermissionMatrixGates({ only: args.only })
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}

import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  errorMessage,
  recordCollabServerEvent,
  type CollabServerEventFields,
} from './audit-log.js'

export interface AuthUser {
  id: string
  name: string
}

export interface VerifiedCollabSession {
  user: AuthUser
  collabGeneration: number
}

export type CollabWsAuthSurface = 'collab-token-subprotocol'

export interface CollabWsUpgradePolicy {
  routeId: string
  path: string
  authSurface: CollabWsAuthSurface
  resource: string
  action: string
  backendVerifierPath: string
  backendVerifierDocIdParam: string
  requiresGenerationCheck: boolean
  requiresMessageReauth: boolean
}

export interface CollabWsUpgradeTestPolicy {
  routeId: string
  testModule: string
  evidence: string
  notes?: string
}

export type CollabAuditRecorder = (
  event: string,
  fields: CollabServerEventFields,
) => Promise<void>

export interface VerifyTokenOptions {
  timeoutMs?: number
  maxTokenChars?: number
  fetchImpl?: typeof fetch
  recordEvent?: CollabAuditRecorder
}

export const COLLAB_VERIFY_TIMEOUT_MS = envPositiveInt('COLLAB_VERIFY_TIMEOUT_MS', 5000)
export const COLLAB_MAX_PENDING_UPGRADES = envPositiveInt('COLLAB_MAX_PENDING_UPGRADES', 100)
export const COLLAB_MAX_TOKEN_CHARS = envPositiveInt('COLLAB_MAX_TOKEN_CHARS', 4096)
export const COLLAB_TOKEN_PROTOCOL_PREFIX = 'superleaf-collab-token.'
export const COLLAB_GENERATION_PROTOCOL_PREFIX = 'superleaf-collab-generation.'

const COLLAB_WS_AUTH_SURFACES = new Set<string>(['collab-token-subprotocol'])

export const COLLAB_WS_UPGRADE_POLICIES: readonly CollabWsUpgradePolicy[] = [
  {
    routeId: 'document_yjs_sync',
    path: '/{docId}',
    authSurface: 'collab-token-subprotocol',
    resource: 'doc',
    action: 'collab_sync',
    backendVerifierPath: '/api/auth/verify',
    backendVerifierDocIdParam: 'doc_id',
    requiresGenerationCheck: true,
    requiresMessageReauth: true,
  },
]

export const COLLAB_WS_UPGRADE_TEST_POLICIES: readonly CollabWsUpgradeTestPolicy[] = [
  {
    routeId: 'document_yjs_sync',
    testModule: 'src/upgrade-auth.test.ts',
    evidence: 'upgrade parser extracts doc id from path and verifyToken sends doc_id to backend verifier',
  },
  {
    routeId: 'document_yjs_sync',
    testModule: 'src/ws-handler.test.ts',
    evidence: 'stale generation is rejected before room load and message-time reauth closes before mutation',
  },
]

export function validateCollabWsUpgradeRegistry(
  policies: readonly CollabWsUpgradePolicy[] = COLLAB_WS_UPGRADE_POLICIES,
): string[] {
  const errors: string[] = []
  const seenPaths = new Set<string>()
  const seenRouteIds = new Set<string>()

  for (const policy of policies) {
    if (seenPaths.has(policy.path)) {
      errors.push(`duplicate collab WebSocket upgrade policy ${policy.path}`)
    }
    seenPaths.add(policy.path)
    if (seenRouteIds.has(policy.routeId)) {
      errors.push(`duplicate collab WebSocket upgrade route id ${policy.routeId}`)
    }
    seenRouteIds.add(policy.routeId)
    if (!COLLAB_WS_AUTH_SURFACES.has(policy.authSurface)) {
      errors.push(`collab WebSocket ${policy.path} has unknown auth surface ${policy.authSurface}`)
    }
    if (policy.backendVerifierPath !== '/api/auth/verify') {
      errors.push(`collab WebSocket ${policy.path} must verify with /api/auth/verify`)
    }
    if (policy.backendVerifierDocIdParam !== 'doc_id') {
      errors.push(`collab WebSocket ${policy.path} must pass doc_id to backend verifier`)
    }
    if (!policy.requiresGenerationCheck) {
      errors.push(`collab WebSocket ${policy.path} must require generation check`)
    }
    if (!policy.requiresMessageReauth) {
      errors.push(`collab WebSocket ${policy.path} must require message-time reauthorization`)
    }
    if (!policy.resource || !policy.action) {
      errors.push(`collab WebSocket ${policy.path} must declare resource and action`)
    }
  }

  return errors
}

export function findUncoveredCollabWsUpgradeTestPolicies(
  policies: readonly CollabWsUpgradePolicy[] = COLLAB_WS_UPGRADE_POLICIES,
  coverage: readonly CollabWsUpgradeTestPolicy[] = COLLAB_WS_UPGRADE_TEST_POLICIES,
): string[] {
  const covered = new Set(coverage.map((policy) => policy.routeId))
  return policies
    .filter((policy) => !covered.has(policy.routeId))
    .map((policy) => `collab WebSocket route ${policy.routeId} has no behavior test coverage`)
    .sort()
}

export function findStaleCollabWsUpgradeTestPolicies(
  policies: readonly CollabWsUpgradePolicy[] = COLLAB_WS_UPGRADE_POLICIES,
  coverage: readonly CollabWsUpgradeTestPolicy[] = COLLAB_WS_UPGRADE_TEST_POLICIES,
): string[] {
  const routeIds = new Set(policies.map((policy) => policy.routeId))
  return coverage
    .filter((policy) => !routeIds.has(policy.routeId))
    .map((policy) => `collab WebSocket coverage ${policy.routeId} references no route policy`)
    .sort()
}

export function findMissingCollabWsUpgradeTestFiles(
  testRoot: string,
  coverage: readonly CollabWsUpgradeTestPolicy[] = COLLAB_WS_UPGRADE_TEST_POLICIES,
  fileExists: (filePath: string) => boolean = existsSync,
): string[] {
  return coverage
    .filter((policy) => !fileExists(path.join(testRoot, policy.testModule)))
    .map((policy) => {
      return `collab WebSocket coverage ${policy.routeId} references missing test file ${policy.testModule}`
    })
    .sort()
}

export function parseCollabProtocols(raw: string | string[] | undefined): {
  token: string | null
  clientGeneration: number | null
} {
  const header = Array.isArray(raw) ? raw.join(',') : raw
  let token: string | null = null
  let clientGeneration: number | null = null
  if (!header) return { token, clientGeneration }
  for (const item of header.split(',')) {
    const protocol = item.trim()
    if (protocol.startsWith(COLLAB_TOKEN_PROTOCOL_PREFIX)) {
      const parsedToken = protocol.slice(COLLAB_TOKEN_PROTOCOL_PREFIX.length).trim()
      token = parsedToken || null
    } else if (protocol.startsWith(COLLAB_GENERATION_PROTOCOL_PREFIX)) {
      const rawGeneration = protocol.slice(COLLAB_GENERATION_PROTOCOL_PREFIX.length).trim()
      const parsedGeneration = Number(rawGeneration)
      clientGeneration = Number.isSafeInteger(parsedGeneration) ? parsedGeneration : null
    }
  }
  return { token, clientGeneration }
}

export function normalizeCollabWsPathPrefix(raw: string): string {
  const value = raw.trim()
  if (!value || value === '/') return ''
  return `/${value.replace(/^\/+/, '').replace(/\/+$/, '')}`
}

export function resolveCollabWsUpgrade(
  rawPath: string,
  rawProtocols: string | string[] | undefined,
  rawPathPrefix = '',
  policies: readonly CollabWsUpgradePolicy[] = COLLAB_WS_UPGRADE_POLICIES,
): {
  policy: CollabWsUpgradePolicy | null
  docId: string | null
  token: string | null
  clientGeneration: number | null
} {
  const { token, clientGeneration } = parseCollabProtocols(rawProtocols)
  const pathname = parsePathname(rawPath)
  const pathPrefix = normalizeCollabWsPathPrefix(rawPathPrefix)
  let docPath = pathname

  if (pathPrefix) {
    if (pathname === pathPrefix || !pathname.startsWith(`${pathPrefix}/`)) {
      return { policy: null, docId: null, token, clientGeneration }
    }
    docPath = pathname.slice(pathPrefix.length)
  }

  const encodedDocId = docPath.replace(/^\/+/, '')
  if (!encodedDocId) {
    return { policy: null, docId: null, token, clientGeneration }
  }

  const policy = policies.find((candidate) => candidate.path === '/{docId}') ?? null
  if (!policy) {
    return { policy: null, docId: null, token, clientGeneration }
  }

  try {
    return {
      policy,
      docId: decodeURIComponent(encodedDocId),
      token,
      clientGeneration,
    }
  } catch {
    return { policy: null, docId: null, token, clientGeneration }
  }
}

export async function verifyToken(
  token: string | null,
  backendUrl: string,
  docId: string,
  options: VerifyTokenOptions = {},
): Promise<VerifiedCollabSession | null> {
  if (!token) return null

  const maxTokenChars = options.maxTokenChars ?? COLLAB_MAX_TOKEN_CHARS
  const recordEvent = options.recordEvent ?? recordCollabServerEvent
  if (token.length > maxTokenChars) {
    await recordEvent('token_verify_rejected', {
      level: 'warning',
      docId,
      operation: 'token_verify',
      code: 'token_too_large',
      details: { token_length: token.length, max_token_chars: maxTokenChars },
    })
    return null
  }

  const timeoutMs = Math.max(1, options.timeoutMs ?? COLLAB_VERIFY_TIMEOUT_MS)
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  let timeoutFired = false
  const timer = setTimeout(() => {
    timeoutFired = true
    controller.abort()
  }, timeoutMs)

  try {
    const url = new URL('/api/auth/verify', backendUrl)
    url.searchParams.set('doc_id', docId)
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      await recordEvent('token_verify_failed', {
        level: 'warning',
        docId,
        operation: 'token_verify',
        code: 'token_verify_failed',
        details: { status: res.status },
      })
      return null
    }
    const data = (await res.json()) as {
      user_id: string
      display_name: string
      collab_generation?: number
    }
    const collabGeneration = data.collab_generation
    if (!Number.isSafeInteger(collabGeneration)) {
      await recordEvent('token_verify_failed', {
        level: 'warning',
        docId,
        operation: 'token_verify',
        code: 'missing_collab_generation',
      })
      return null
    }
    return {
      user: { id: data.user_id, name: data.display_name },
      collabGeneration: collabGeneration as number,
    }
  } catch (err) {
    if (timeoutFired || isAbortError(err)) {
      await recordEvent('token_verify_timeout', {
        level: 'warning',
        docId,
        operation: 'token_verify',
        code: 'token_verify_timeout',
        details: { timeout_ms: timeoutMs },
      })
      return null
    }
    await recordEvent('token_verify_exception', {
      level: 'error',
      docId,
      operation: 'token_verify',
      code: 'token_verify_exception',
      message: errorMessage(err),
    })
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function createUpgradeAuthLimiter(maxPending = COLLAB_MAX_PENDING_UPGRADES): UpgradeAuthLimiter {
  return new UpgradeAuthLimiter(maxPending)
}

export class UpgradeAuthLimiter {
  private pending = 0
  private readonly maxPending: number

  constructor(maxPending: number) {
    this.maxPending = Number.isSafeInteger(maxPending) && maxPending > 0 ? maxPending : 1
  }

  get pendingCount(): number {
    return this.pending
  }

  tryAcquire(): (() => void) | null {
    if (this.pending >= this.maxPending) return null
    this.pending += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.pending = Math.max(0, this.pending - 1)
    }
  }
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function parsePathname(rawPath: string): string {
  try {
    return new URL(rawPath || '/', 'http://collab.local').pathname
  } catch {
    return rawPath || '/'
  }
}

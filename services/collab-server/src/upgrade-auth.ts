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

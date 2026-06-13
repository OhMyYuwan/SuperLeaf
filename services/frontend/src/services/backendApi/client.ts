/**
 * backendApi — typed fetch helpers for our FastAPI.
 *
 * Base URL resolution:
 *   1. window.__SUPERLEAF_CONFIG__.backendUrl if provided by deployment
 *   2. import.meta.env.VITE_BACKEND_URL if provided at build time
 *   3. Use same-origin /api for production/all-in-one deployments
 *   4. Auto-detect based on current hostname only for Vite development
 *   4. http://localhost:8000 fallback
 */

import { getRuntimeConfigValue, normalizeHttpBase } from '../runtimeConfig'

function getBackendUrl(): string {
  const runtimeBackendUrl = getRuntimeConfigValue('backendUrl')
  if (runtimeBackendUrl !== undefined) {
    return normalizeHttpBase(runtimeBackendUrl)
  }
  if (import.meta.env.VITE_BACKEND_URL) {
    return normalizeHttpBase(import.meta.env.VITE_BACKEND_URL)
  }
  if (typeof window !== 'undefined') {
    const { protocol, hostname, port } = window.location
    // Vite dev/preview serves the frontend separately, so use the backend port.
    if (port === '5173' || port === '5174' || port === '4173') {
      const url = `${protocol}//${hostname}:8000`
      console.log('[backendApi] Using dev backend URL:', url)
      return url
    }

    // Packaged Docker/all-in-one deployments proxy /api through the same host.
    // This keeps cookies same-origin and avoids probing an unexposed :8000 port.
    console.log('[backendApi] Using same-origin backend URL')
    return ''
  }
  console.log('[backendApi] Using default backend URL: http://127.0.0.1:8000')
  return 'http://127.0.0.1:8000'
}

export const BASE = getBackendUrl()
console.log('[backendApi] Backend URL initialized:', BASE)

export function getLocalServiceUrl(port: number): string {
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location
    const host = hostname === 'localhost' ? '127.0.0.1' : hostname
    return `${protocol}//${host}:${port}`
  }
  return `http://127.0.0.1:${port}`
}

export function getBrowserLocalServiceUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

export async function http<T>(path: string, init?: HttpInit): Promise<T> {
  const headers = buildHeaders(init?.headers, init?.scope ?? 'project')
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  })
  if (resp.status === 401) {
    notifyUnauthorized()
  }
  if (resp.status === 204) return undefined as T
  const text = await resp.text()
  if (!resp.ok) {
    throw new BackendError(resp.status, parseErrorDetail(text) || resp.statusText)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

export async function downloadBackendFile(path: string, fallbackFilename: string): Promise<void> {
  const resp = await fetch(`${BASE}${path}`, {
    method: 'GET',
    credentials: 'include',
  })
  if (resp.status === 401) {
    notifyUnauthorized()
  }
  if (!resp.ok) {
    const text = await resp.text()
    throw new BackendError(resp.status, parseErrorDetail(text) || resp.statusText)
  }
  const blob = await resp.blob()
  const filename = filenameFromContentDisposition(resp.headers.get('Content-Disposition') ?? '') ?? fallbackFilename
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

function filenameFromContentDisposition(disposition: string): string | null {
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      return encoded
    }
  }
  return disposition.match(/filename="([^"]+)"/i)?.[1] ?? disposition.match(/filename=([^;]+)/i)?.[1] ?? null
}

function parseErrorDetail(text: string): string {
  if (!text) return ''
  try {
    const payload = JSON.parse(text) as { detail?: unknown }
    if (typeof payload.detail === 'string') return payload.detail
    if (payload.detail && typeof payload.detail === 'object' && !Array.isArray(payload.detail)) {
      const detail = payload.detail as { message?: unknown; code?: unknown }
      if (typeof detail.message === 'string') return detail.message
      if (typeof detail.code === 'string') return detail.code
    }
    if (Array.isArray(payload.detail)) {
      return payload.detail
        .map((item) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object' && 'msg' in item) return String((item as { msg: unknown }).msg)
          return ''
        })
        .filter(Boolean)
        .join('; ')
    }
  } catch {
    return text
  }
  return text
}

export type RequestScope = 'project' | 'global'

export interface HttpInit extends Omit<RequestInit, 'headers'> {
  headers?: HeadersInit
  // 'project' (default) injects the X-Project-Id header from projectStore.
  // 'global' skips that injection — used by /api/projects, /api/health, etc.
  scope?: RequestScope
}

/** Compose request headers with optional X-Project-Id injection.
 *
 *  Exposed so SSE callers (which use fetch directly) can reuse the same logic.
 *  Reads `currentProjectId` from `projectStore` lazily to avoid an import cycle.
 */

export function buildHeaders(extra?: HeadersInit, scope: RequestScope = 'project'): Headers {
  const headers = new Headers(extra ?? undefined)
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (scope === 'project' && !headers.has('X-Project-Id')) {
    const pid = readCurrentProjectId()
    if (pid) headers.set('X-Project-Id', pid)
  }
  // Stable per-browser id so the SSE event stream can flag self-originated
  // events and avoid double-applying optimistic mutations.
  if (!headers.has('X-Client-Id')) {
    headers.set('X-Client-Id', getClientId())
  }
  return headers
}

const CLIENT_ID_KEY = 'yuwan-client-id'

let cachedClientId: string | null = null

export function getClientId(): string {
  if (cachedClientId) return cachedClientId
  if (typeof localStorage === 'undefined') {
    cachedClientId = `tmp-${Math.random().toString(36).slice(2, 10)}`
    return cachedClientId
  }
  const existing = localStorage.getItem(CLIENT_ID_KEY)
  if (existing) {
    cachedClientId = existing
    return existing
  }
  const fresh = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `c-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`
  localStorage.setItem(CLIENT_ID_KEY, fresh)
  cachedClientId = fresh
  return fresh
}

// Avoids `import { useProjectStore }` at module load (circular: projectStore
// uses backendApi for its own HTTP calls). Resolved lazily on first call.

let projectIdReader: (() => string | null) | null = null

export function registerProjectIdReader(reader: () => string | null): void {
  projectIdReader = reader
}

function readCurrentProjectId(): string | null {
  return projectIdReader ? projectIdReader() : null
}

// 401 interceptor — userStore registers a handler that clears its state and
// triggers a router-level redirect to /login. Lazy registration same as above.

const unauthorizedHandlers: Array<() => void> = []

export function registerUnauthorizedHandler(cb: () => void): void {
  unauthorizedHandlers.push(cb)
}

function notifyUnauthorized(): void {
  for (const cb of unauthorizedHandlers) {
    try {
      cb()
    } catch (e) {
      console.warn('[backendApi] unauthorized handler threw', e)
    }
  }
}

export class BackendError extends Error {
  readonly status: number
  readonly detail: string
  constructor(status: number, detail: string) {
    super(`Backend ${status}: ${detail}`)
    this.status = status
    this.detail = detail
  }
}

export const BACKEND_BASE = BASE

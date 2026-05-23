/**
 * projectEventStream — subscribes to /api/projects/{id}/events SSE so the
 * client receives mutations from other browsers/devices in real time.
 *
 * Why we built our own (vs swr / tanstack): the events are project-scoped,
 * authentication is cookie-based (so plain EventSource works), and we need
 * to dispatch into multiple zustand stores with side-effects on origin
 * filtering. A 100-LOC dedicated module is cheaper than a generic layer.
 *
 * Lifecycle (driven by ProjectEventBridge component):
 *   - `start(projectId, onEvent)` opens an EventSource and resubscribes
 *     after disconnects with exponential backoff (1s, 2s, 4s, capped 30s).
 *   - `stop()` closes the stream and cancels pending reconnects.
 *
 * Self-echo filtering: every event carries `origin_client_id`. The bridge
 * skips events from `getClientId()` so the local optimistic update isn't
 * doubled.
 *
 * Duplicate-id filtering: events carry a UUID `id`. We remember the last
 * 128 ids to ignore replays that may happen during a transient reconnect.
 * Events also carry a best-effort per-project `seq`; the bridge can use gaps
 * as a signal to reload authoritative project state.
 */

import { BACKEND_BASE, getClientId } from './backendApi'

export interface ProjectEvent {
  id: string
  seq?: number
  type: string
  ts: string
  project_id: string
  origin_client_id: string
  payload: Record<string, unknown>
}

type Handler = (event: ProjectEvent) => void
type ReconnectHandler = () => void

const SEEN_CAP = 128

class Stream {
  private es: EventSource | null = null
  private projectId: string | null = null
  private handler: Handler | null = null
  private reconnectListeners: Set<ReconnectHandler> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs = 1000
  private seen: string[] = []
  private stopped = true
  private hadDisconnectSinceLastHydrate = false

  start(projectId: string, handler: Handler): void {
    if (this.projectId === projectId && this.es && this.es.readyState !== EventSource.CLOSED) {
      this.handler = handler
      return
    }
    this.stop()
    this.stopped = false
    this.projectId = projectId
    this.handler = handler
    this.connect()
  }

  /** Register a callback that fires when the SSE stream reconnects after a
   *  disconnect. Returns an unsubscribe function. */
  onReconnect(fn: ReconnectHandler): () => void {
    this.reconnectListeners.add(fn)
    return () => this.reconnectListeners.delete(fn)
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.es) {
      this.es.close()
      this.es = null
    }
    this.projectId = null
    this.handler = null
    this.backoffMs = 1000
  }

  private connect(): void {
    if (this.stopped || !this.projectId) return
    const url = `${BACKEND_BASE}/api/projects/${encodeURIComponent(this.projectId)}/events`
    // EventSource doesn't let us set headers, so we rely on the cookie for
    // auth and pass client-id via query string for the server to attach
    // back into origin_client_id when needed. (Currently unused — we only
    // use client-id on mutation requests via X-Client-Id header.)
    const es = new EventSource(url, { withCredentials: true })
    this.es = es

    const onMessage = (evt: MessageEvent) => {
      if (!evt.data) return
      let parsed: ProjectEvent
      try {
        parsed = JSON.parse(evt.data)
      } catch {
        return
      }
      if (!parsed.id || !parsed.type) return
      // De-dup across reconnects.
      if (this.seen.includes(parsed.id)) return
      this.seen.push(parsed.id)
      if (this.seen.length > SEEN_CAP) this.seen.splice(0, this.seen.length - SEEN_CAP)
      // Drop self-echo: this browser already applied an optimistic mutation.
      if (parsed.origin_client_id && parsed.origin_client_id === getClientId()) return
      this.handler?.(parsed)
    }

    // We use named events on the server (event: annotation.review_status.changed).
    // To handle arbitrary event types, listen on every known one. Easier: also
    // add the generic 'message' listener for safety, plus explicit listeners
    // for our known event names so onmessage fallback isn't required.
    const KNOWN = [
      'annotation.review_status.changed',
      'annotation.evaluation.created',
      'annotation.evaluation.updated',
      'annotation.evaluation.deleted',
      'annotation.created',
      'annotation.updated',
      'annotation.deleted',
      'doc.updated',
      'project.tree.changed',
    ]
    for (const t of KNOWN) {
      es.addEventListener(t, onMessage as EventListener)
    }
    es.addEventListener('ylw.heartbeat', () => {
      // Successful traffic → reset backoff.
      this.backoffMs = 1000
    })
    es.addEventListener('ylw.hello', () => {
      this.backoffMs = 1000
      // If we had a prior disconnect, notify listeners so they can hydrate
      // immediately rather than waiting for the next focus event.
      if (this.hadDisconnectSinceLastHydrate) {
        for (const fn of this.reconnectListeners) fn()
      }
    })

    es.onerror = () => {
      // EventSource tries to auto-reconnect, but on auth failure / CORS /
      // server kill we'd just spin. Close and reconnect with backoff.
      es.close()
      this.es = null
      if (this.stopped) return
      // Mark that we had a disconnect so the next focus/visibility event
      // triggers a full hydrate to catch up on any missed SSE events.
      this.hadDisconnectSinceLastHydrate = true
      const delay = this.backoffMs
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    }
  }

  /** Returns true if the SSE stream has disconnected since the last hydrate.
   *  Used by WorkspacePage to decide whether a focus-triggered hydrate is needed. */
  needsHydrate(): boolean {
    return this.hadDisconnectSinceLastHydrate
  }

  /** Called by annotationStore.hydrateForDoc after a successful hydrate. */
  markHydrated(): void {
    this.hadDisconnectSinceLastHydrate = false
  }
}

export const projectEventStream = new Stream()

/**
 * Minimal toast host — no external deps.
 *
 * Why we have this: V3 Phase 4 mutations (review_status / evaluation) need to
 * surface backend failures to the user so the UI stops silently dropping
 * writes (Overleaf's `showGenericMessageModal` pattern, scaled down).
 *
 *   showToast('未能保存评价，已恢复', { level: 'error' })
 *
 * The host is mounted once at the App root via `<ToastHost />`. Each toast
 * auto-dismisses after `duration` ms (default 4000 for info, 6000 for error).
 * Errors are also `console.error`-logged so devs can grep.
 *
 * Implementation notes:
 *   - Module-level subscribers list. `showToast()` works even before React
 *     mounts; the host catches up on mount.
 *   - No portals, no animations beyond a CSS class — keep it boring.
 */

import { useEffect, useState } from 'react'

export type ToastLevel = 'info' | 'success' | 'error' | 'warning'

export interface ToastOptions {
  level?: ToastLevel
  duration?: number
}

interface ToastItem {
  id: number
  message: string
  level: ToastLevel
  duration: number
}

type Listener = (toasts: ToastItem[]) => void

let nextId = 1
let toasts: ToastItem[] = []
const listeners = new Set<Listener>()

function notify(): void {
  for (const l of listeners) l(toasts)
}

export function showToast(message: string, opts: ToastOptions = {}): number {
  const level = opts.level ?? 'info'
  const duration = opts.duration ?? (level === 'error' ? 6000 : 4000)
  const item: ToastItem = { id: nextId++, message, level, duration }
  toasts = [...toasts, item]
  if (level === 'error') console.error('[toast]', message)
  notify()
  if (duration > 0) {
    setTimeout(() => dismissToast(item.id), duration)
  }
  return item.id
}

export function dismissToast(id: number): void {
  const next = toasts.filter((t) => t.id !== id)
  if (next.length === toasts.length) return
  toasts = next
  notify()
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>(toasts)
  useEffect(() => {
    const listener: Listener = (next) => setItems(next)
    listeners.add(listener)
    // Catch any toasts created before mount.
    setItems(toasts)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  if (items.length === 0) return null
  return (
    <div className="toast-host" role="region" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.level}`}
          role={t.level === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-message">{t.message}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => dismissToast(t.id)}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

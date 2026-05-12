/**
 * `userScopedStorage` — drop-in replacement for zustand-persist's default
 * localStorage, scoped under a per-user prefix.
 *
 * Why: documentStore / annotationStore persist into localStorage with a
 * fixed `name`. Two accounts sharing a browser would otherwise hydrate each
 * other's cached docs/annotations. Overleaf avoids this by keeping state on
 * the server with cookie-bound sessions; we're not there yet, so the
 * minimum bar is account isolation in localStorage keys.
 *
 * `userStore` calls `setUserScopeId(userId | null)` whenever the auth state
 * changes. The storage layer reads that variable on every get/set/remove,
 * so as soon as `loadMe()` resolves, subsequent persist writes go under
 * the right namespace. Pre-auth state lives under `__anon` and is
 * untouched on login.
 *
 * After login userStore also calls `useDocumentStore.persist.rehydrate()`
 * (and same for annotationStore) so the store re-reads from the new key.
 */

import type { PersistStorage } from 'zustand/middleware'

let currentUserScopeId: string = '__anon'

export function setUserScopeId(userId: string | null): void {
  currentUserScopeId = userId ?? '__anon'
}

export function getUserScopeId(): string {
  return currentUserScopeId
}

function scoped(name: string): string {
  return `${name}::user:${currentUserScopeId}`
}

export function createUserScopedStorage<T>(): PersistStorage<T> {
  return {
    getItem: (name) => {
      if (typeof localStorage === 'undefined') return null
      const raw = localStorage.getItem(scoped(name))
      if (raw == null) return null
      try {
        return JSON.parse(raw) as { state: T; version?: number }
      } catch {
        return null
      }
    },
    setItem: (name, value) => {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem(scoped(name), JSON.stringify(value))
    },
    removeItem: (name) => {
      if (typeof localStorage === 'undefined') return
      localStorage.removeItem(scoped(name))
    },
  }
}

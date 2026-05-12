/**
 * userStore — current user + auth lifecycle.
 *
 * Bootstrap order: on app mount, `loadMe()` is called once via
 * `<ProtectedRoute>`. It returns a User on success and clears state on 401.
 *
 * The 401 interceptor (registered against `backendApi`) resets this store as
 * a side effect so the next render of `<ProtectedRoute>` redirects to /login.
 *
 * `logout()` and 401 also call `resetUserScopedStores()` so per-user caches
 * (projects, providers, cached agents) cannot leak across sessions.
 */

import { create } from 'zustand'
import { authApi, type LoginBody, type RegisterBody, type User } from '../services/authApi'
import { BackendError, registerUnauthorizedHandler } from '../services/backendApi'
import { resetUserScopedStores } from './_reset'
import { setUserScopeId } from './_userScopedStorage'

// After auth state changes, the per-user persist namespace must flip and the
// stores need to re-read from the new localStorage key. We can't import the
// stores here (they import from this module via _reset), so we do a lazy
// dynamic import.
async function applyUserScope(userId: string | null): Promise<void> {
  setUserScopeId(userId)
  const [{ useDocumentStore }, { useAnnotationStore }] = await Promise.all([
    import('./documentStore'),
    import('./annotationStore'),
  ])
  await Promise.all([
    useDocumentStore.persist.rehydrate() ?? Promise.resolve(),
    useAnnotationStore.persist.rehydrate() ?? Promise.resolve(),
  ])
}

interface UserState {
  currentUser: User | null
  loading: boolean
  loaded: boolean
  error: string | null

  loadMe: () => Promise<void>
  login: (body: LoginBody) => Promise<User>
  register: (body: RegisterBody) => Promise<User>
  logout: () => Promise<void>
  // Called by 401 interceptor — clears state without hitting the backend.
  handleUnauthorized: () => void
}

export const useUserStore = create<UserState>((set, get) => ({
  currentUser: null,
  loading: false,
  loaded: false,
  error: null,

  loadMe: async () => {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const user = await authApi.me()
      await applyUserScope(user.id)
      set({ currentUser: user, loading: false, loaded: true })
    } catch (e) {
      // 401 is the expected "not logged in" path — surface as null, not error.
      if (e instanceof BackendError && e.status === 401) {
        set({ currentUser: null, loading: false, loaded: true })
        return
      }
      set({
        currentUser: null,
        loading: false,
        loaded: true,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  },

  login: async (body) => {
    const user = await authApi.login(body)
    await applyUserScope(user.id)
    set({ currentUser: user, loaded: true, error: null })
    return user
  },

  register: async (body) => {
    const user = await authApi.register(body)
    await applyUserScope(user.id)
    set({ currentUser: user, loaded: true, error: null })
    return user
  },

  logout: async () => {
    try {
      await authApi.logout()
    } catch {
      // Even if backend is unreachable, drop local state.
    }
    set({ currentUser: null, loaded: true, error: null })
    await resetUserScopedStores()
    await applyUserScope(null)
  },

  handleUnauthorized: () => {
    // Avoid clobbering a fresh login that just succeeded — only clear if
    // we actually had a user.
    if (get().currentUser !== null) {
      set({ currentUser: null, loaded: true })
      void resetUserScopedStores().then(() => applyUserScope(null))
    }
  },
}))

// Hook the 401 interceptor. Module-load side effect, mirrors how
// projectStore registers its X-Project-Id reader.
registerUnauthorizedHandler(() => {
  useUserStore.getState().handleUnauthorized()
})

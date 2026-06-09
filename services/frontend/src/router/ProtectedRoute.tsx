/**
 * ProtectedRoute — gate any route behind userStore.currentUser.
 *
 * On first mount, kicks off `loadMe()` if it hasn't run yet. While the
 * initial me() request is in flight, renders a thin loading shim so we
 * don't flash the login screen for already-authenticated users on reload.
 *
 * On 401, the global interceptor in backendApi calls
 * `userStore.handleUnauthorized()` which clears currentUser; the next render
 * here naturally redirects to /login.
 */

import { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useUserStore } from '../stores/userStore'

interface Props {
  children: React.ReactNode
  requireAdmin?: boolean
}

export function ProtectedRoute({ children, requireAdmin = false }: Props) {
  const location = useLocation()
  const currentUser = useUserStore((s) => s.currentUser)
  const loaded = useUserStore((s) => s.loaded)
  const loading = useUserStore((s) => s.loading)
  const loadMe = useUserStore((s) => s.loadMe)

  useEffect(() => {
    if (!loaded && !loading) {
      void loadMe()
    }
  }, [loaded, loading, loadMe])

  if (!loaded) {
    return <div className="auth-boot-shim" aria-busy="true" />
  }

  if (!currentUser) {
    // Preserve the requested URL so we can bounce back after login.
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    )
  }

  if (requireAdmin && !currentUser.is_admin) {
    return <Navigate to="/projects" replace />
  }

  return <>{children}</>
}

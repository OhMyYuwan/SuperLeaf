/**
 * Top-level router.
 *
 *   /login                     → <LoginPage />     公开
 *   /register                  → <RegisterPage />  公开
 *   /                          → redirect /projects
 *   /projects                  → <ProjectListPage />     (protected)
 *   /projects/:projectId/*     → <WorkspacePage />        (protected, `*`
 *                                reserves room for future deep-link segments
 *                                like /docs/<id>)
 *   anything else              → redirect /projects
 */

import { Navigate, Route, Routes } from 'react-router-dom'
import { ProjectListPage } from './pages/ProjectListPage'
import { WorkspacePage } from './pages/WorkspacePage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { ProtectedRoute } from './router/ProtectedRoute'

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/" element={<Navigate to="/projects" replace />} />
      <Route
        path="/projects"
        element={
          <ProtectedRoute>
            <ProjectListPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/projects/:projectId/*"
        element={
          <ProtectedRoute>
            <WorkspacePage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  )
}

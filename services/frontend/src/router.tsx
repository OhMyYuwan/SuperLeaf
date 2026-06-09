/**
 * Top-level router.
 *
 *   /login                     → <LoginPage />     公开
 *   /register                  → <RegisterPage />  公开
 *   /                          → redirect /projects
 *   /admin                     → <AdminPage />           (admin protected)
 *   /projects                  → <ProjectListPage />     (protected)
 *   /projects/:projectId/*     → <ProjectRoutePage />     (protected,
 *                                dispatches data projects to the dataset
 *                                workbench and paper/skill projects to the
 *                                writing workspace)
 *   anything else              → redirect /projects
 */

import { Navigate, Route, Routes } from 'react-router-dom'
import { ProjectListPage } from './pages/ProjectListPage'
import { ProjectRoutePage } from './pages/ProjectRoutePage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { AdminPage } from './pages/AdminPage'
import { ProtectedRoute } from './router/ProtectedRoute'

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/" element={<Navigate to="/projects" replace />} />
      <Route
        path="/admin"
        element={
          <ProtectedRoute requireAdmin>
            <AdminPage />
          </ProtectedRoute>
        }
      />
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
            <ProjectRoutePage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  )
}

/**
 * Top-level router.
 *
 *   /                          → redirect /projects
 *   /projects                  → <ProjectListPage />
 *   /projects/:projectId/*     → <WorkspacePage />   (`*` reserves room for
 *                                future deep-link segments like
 *                                `/docs/<id>` without forcing another route
 *                                refactor)
 *   anything else              → redirect /projects
 */

import { Navigate, Route, Routes } from 'react-router-dom'
import { ProjectListPage } from './pages/ProjectListPage'
import { WorkspacePage } from './pages/WorkspacePage'

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/projects" replace />} />
      <Route path="/projects" element={<ProjectListPage />} />
      <Route path="/projects/:projectId/*" element={<WorkspacePage />} />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  )
}

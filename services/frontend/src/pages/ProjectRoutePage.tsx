import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { Topbar } from '../features/topbar'
import { useProjectStore } from '../stores/projectStore'
import { resetProjectScopedStores } from '../stores/_reset'
import { DataProjectPage } from './DataProjectPage'
import { WorkspacePage } from './WorkspacePage'

export function ProjectRoutePage() {
  const { projectId = '' } = useParams<{ projectId: string }>()
  const projects = useProjectStore((s) => s.projects)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const loaded = useProjectStore((s) => s.loaded)
  const loading = useProjectStore((s) => s.loading)
  const loadProjects = useProjectStore((s) => s.load)
  const setCurrent = useProjectStore((s) => s.setCurrent)

  useEffect(() => {
    if (!projectId || currentProjectId === projectId) return
    setCurrent(projectId)
    resetProjectScopedStores()
  }, [currentProjectId, projectId, setCurrent])

  useEffect(() => {
    if (!loaded && !loading) {
      void loadProjects()
    }
  }, [loadProjects, loaded, loading])

  if (!projectId) {
    return <Navigate to="/projects" replace />
  }

  const project = projects.find((item) => item.id === projectId) ?? null

  if (!loaded || loading || currentProjectId !== projectId) {
    return (
      <ProjectRouteShell
        title="正在打开项目"
        detail={project?.name ?? projectId.slice(0, 8)}
      />
    )
  }

  if (!project) {
    return (
      <ProjectRouteShell
        title="没有找到这个项目"
        detail="它可能已经被删除，或者你没有访问权限。"
      >
        <Link className="primary-btn" to="/projects">返回项目列表</Link>
      </ProjectRouteShell>
    )
  }

  if (project.project_type === 'data') {
    return <DataProjectPage project={project} />
  }

  return <WorkspacePage />
}

function ProjectRouteShell({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children?: ReactNode
}) {
  return (
    <div className="app-shell">
      <Topbar />
      <main className="workspace">
        <div className="project-switch-overlay">
          <div className="project-switch-indicator">
            <div className="project-switch-label">{title}</div>
            <div className="project-switch-name">{detail}</div>
            {children ?? (
              <div className="project-switch-progress" aria-hidden>
                <span />
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

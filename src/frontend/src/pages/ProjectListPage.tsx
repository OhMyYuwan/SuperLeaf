/**
 * ProjectListPage — landing view at /projects.
 *
 * Shows all projects in either a card grid or a table. The view mode toggle
 * persists to localStorage via projectStore.setViewMode. New project / rename /
 * delete go through the three dialogs in ./components.
 *
 * After create() we navigate the user straight into the new project — that
 * matches the Overleaf flow where "New Project" jumps you into the workspace.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, List, Plus } from 'lucide-react'
import { useProjectStore } from '../stores/projectStore'
import type { ProjectSummary } from '../services/projectsApi'
import { BackendError } from '../services/backendApi'
import { ProjectCard } from './components/ProjectCard'
import { ProjectTableRow } from './components/ProjectTableRow'
import { ProjectFormDialog } from './components/ProjectFormDialog'
import { DeleteProjectDialog } from './components/DeleteProjectDialog'
import { UserMenu } from '../features/topbar/UserMenu'
import './project-list.css'

type DialogState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'rename'; target: ProjectSummary }
  | { kind: 'delete'; target: ProjectSummary }

export function ProjectListPage() {
  const navigate = useNavigate()
  const projects = useProjectStore((s) => s.projects)
  const loading = useProjectStore((s) => s.loading)
  const loaded = useProjectStore((s) => s.loaded)
  const error = useProjectStore((s) => s.error)
  const load = useProjectStore((s) => s.load)
  const create = useProjectStore((s) => s.create)
  const rename = useProjectStore((s) => s.rename)
  const remove = useProjectStore((s) => s.remove)
  const viewMode = useProjectStore((s) => s.viewMode)
  const setViewMode = useProjectStore((s) => s.setViewMode)

  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' })
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  useEffect(() => {
    load()
  }, [load])

  const closeDialog = () => {
    setDialog({ kind: 'closed' })
    setDialogError(null)
    setDialogBusy(false)
  }

  const handleCreate = async (name: string) => {
    setDialogBusy(true)
    setDialogError(null)
    try {
      const created = await create(name)
      closeDialog()
      navigate(`/projects/${created.id}`)
    } catch (e) {
      setDialogError(extractMessage(e))
    } finally {
      setDialogBusy(false)
    }
  }

  const handleRename = async (name: string) => {
    if (dialog.kind !== 'rename') return
    setDialogBusy(true)
    setDialogError(null)
    try {
      await rename(dialog.target.id, name)
      closeDialog()
    } catch (e) {
      setDialogError(extractMessage(e))
    } finally {
      setDialogBusy(false)
    }
  }

  const handleDelete = async () => {
    if (dialog.kind !== 'delete') return
    setDialogBusy(true)
    setDialogError(null)
    try {
      await remove(dialog.target.id)
      closeDialog()
    } catch (e) {
      setDialogError(extractMessage(e))
    } finally {
      setDialogBusy(false)
    }
  }

  return (
    <div className="project-list-page">
      <header className="project-list-header">
        <div>
          <div className="brand">YuwanLabWriter</div>
          <div className="subtitle">选择或创建一个项目</div>
        </div>
        <div className="project-list-header-actions">
          <div className="view-toggle" role="tablist" aria-label="切换视图">
            <button
              role="tab"
              aria-selected={viewMode === 'grid'}
              className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="卡片视图"
            >
              <LayoutGrid size={14} /> 卡片
            </button>
            <button
              role="tab"
              aria-selected={viewMode === 'table'}
              className={`view-toggle-btn ${viewMode === 'table' ? 'active' : ''}`}
              onClick={() => setViewMode('table')}
              title="表格视图"
            >
              <List size={14} /> 表格
            </button>
          </div>
          <button className="primary-btn" onClick={() => setDialog({ kind: 'create' })}>
            <Plus size={14} /> 新建项目
          </button>
          <UserMenu />
        </div>
      </header>

      <main className="project-list-main">
        {!loaded && loading && <div className="project-list-empty">加载中…</div>}
        {loaded && error && <div className="project-list-error">{error}</div>}
        {loaded && !error && projects.length === 0 && (
          <div className="project-list-empty">
            还没有项目。点击右上角「新建项目」开始你的第一个写作工作台。
          </div>
        )}

        {projects.length > 0 && viewMode === 'grid' && (
          <div className="project-grid">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onRename={(target) => setDialog({ kind: 'rename', target })}
                onDelete={(target) => setDialog({ kind: 'delete', target })}
              />
            ))}
          </div>
        )}

        {projects.length > 0 && viewMode === 'table' && (
          <table className="project-table">
            <thead>
              <tr>
                <th>项目名称</th>
                <th>最后更新</th>
                <th>创建时间</th>
                <th aria-label="操作"></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <ProjectTableRow
                  key={p.id}
                  project={p}
                  onRename={(target) => setDialog({ kind: 'rename', target })}
                  onDelete={(target) => setDialog({ kind: 'delete', target })}
                />
              ))}
            </tbody>
          </table>
        )}
      </main>

      <ProjectFormDialog
        open={dialog.kind === 'create'}
        mode="create"
        busy={dialogBusy}
        error={dialogError}
        onSubmit={handleCreate}
        onOpenChange={(o) => { if (!o) closeDialog() }}
      />
      <ProjectFormDialog
        open={dialog.kind === 'rename'}
        mode="rename"
        initialName={dialog.kind === 'rename' ? dialog.target.name : ''}
        busy={dialogBusy}
        error={dialogError}
        onSubmit={handleRename}
        onOpenChange={(o) => { if (!o) closeDialog() }}
      />
      <DeleteProjectDialog
        open={dialog.kind === 'delete'}
        projectName={dialog.kind === 'delete' ? dialog.target.name : ''}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={handleDelete}
        onOpenChange={(o) => { if (!o) closeDialog() }}
      />
    </div>
  )
}

function extractMessage(e: unknown): string {
  if (e instanceof BackendError) return e.detail || e.message
  if (e instanceof Error) return e.message
  return String(e)
}
